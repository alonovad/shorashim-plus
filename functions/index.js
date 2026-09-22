const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { defineSecret } = require("firebase-functions/params");

initializeApp();

// Set once with: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// ═══════════════════════════════════════════
// 1. SET USER ROLE — sets custom claims on auth token
//    Called by admin when creating/editing users
// ═══════════════════════════════════════════

exports.setUserRole = onCall(
  { region: "us-central1" },
  async (request) => {
    // Only admins can set roles
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    // Check caller is admin (via custom claim or allow the first user to bootstrap)
    const callerClaims = request.auth.token;
    const auth = getAuth();

    // Bootstrap: if no users have roles yet, allow the first call
    if (callerClaims.role !== "admin") {
      // Check if ANY user has admin role — if not, this is bootstrap
      const listResult = await auth.listUsers(100);
      const hasAdmin = listResult.users.some(
        (u) => u.customClaims && u.customClaims.role === "admin"
      );
      if (hasAdmin) {
        throw new HttpsError("permission-denied", "Only admins can set roles");
      }
      // No admin exists — allow bootstrap
    }

    const { uid, role } = request.data;
    if (!uid || !role) {
      throw new HttpsError("invalid-argument", "uid and role required");
    }
    if (!["admin", "operator", "worker", "viewer"].includes(role)) {
      throw new HttpsError("invalid-argument", "Invalid role: " + role);
    }

    await auth.setCustomUserClaims(uid, { role });
    return { success: true, uid, role };
  }
);

// ═══════════════════════════════════════════
// 2. TALGIL PROXY — with auth verification
// ═══════════════════════════════════════════

//  (appData/shorashim-users) and the custom claim on their Auth token.
//  firestore.rules can only read the claim — it cannot read Firestore
//  while evaluating a rule. Only the Admin SDK can write a claim.
//  setUserRole (above) was deployed but never called from the client, so
//  every account has an empty claim and the whole app has been running on
//  the noRoleYet() escape hatch in the rules. These three functions close
//  that gap so noRoleYet() can be removed.
//
//  ESCALATION NOTE
//  appData/shorashim-users is currently writable by any signed-in user
//  (see the TEMPORARY grant in firestore.rules). A function that blindly
//  copied the profile role onto the token would therefore let a worker
//  edit their own profile to "admin" and mint a real admin token — turning
//  a UI-gated hole into a token-level one. So the split below is
//  deliberate: self-service (claimSelfFromProfile) can only ever grant the
//  two powerless tiers. Elevation to operator/admin always requires a call
//  made BY an admin.
// ═══════════════════════════════════════════

const VALID_ROLES = ["admin", "operator", "worker", "viewer"];
const SELF_GRANTABLE = ["worker", "viewer"];

// Shared admin gate. Mirrors setUserRole: while no account anywhere holds
// an admin claim the system is un-bootstrapped, so the first caller is
// allowed through. That window closes permanently the moment the backfill
// stamps the first admin.
async function assertAdminOrBootstrap(request, auth) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in");
  }
  if (request.auth.token.role === "admin") return;
  const listResult = await auth.listUsers(1000);
  const hasAdmin = listResult.users.some(
    (u) => u.customClaims && u.customClaims.role === "admin"
  );
  if (hasAdmin) {
    throw new HttpsError("permission-denied", "Only admins can set roles");
  }
}

// Profiles are keyed by username but looked up here by email, because the
// email is the only thing an Auth account and a profile reliably share.
// Casing is not normalised in older profiles, so compare lowercased.
async function loadProfiles(db) {
  const doc = await db.collection("appData").doc("shorashim-users").get();
  return (doc.exists && doc.data().value) || {};
}
function findProfileByEmail(users, email) {
  const needle = String(email || "").trim().toLowerCase();
  if (!needle) return null;
  return (
    Object.values(users).find(
      (u) => u && u.email && String(u.email).trim().toLowerCase() === needle
    ) || null
  );
}

// ── Admin: stamp one user by email ──
// Called by the user-management UI right after it writes a profile, so a
// role set in the UI takes effect without waiting for a backfill run.
// Returns pending:true when the person has no Auth account yet (added by
// an admin but never logged in) — there is no token to stamp, and
// claimSelfFromProfile or the next admin backfill picks them up later.
exports.setUserRoleByEmail = onCall(
  { region: "us-central1" },
  async (request) => {
    const auth = getAuth();
    await assertAdminOrBootstrap(request, auth);

    const email = String((request.data && request.data.email) || "").trim().toLowerCase();
    const role = (request.data && request.data.role) || "";
    if (!email || !role) {
      throw new HttpsError("invalid-argument", "email and role required");
    }
    if (!VALID_ROLES.includes(role)) {
      throw new HttpsError("invalid-argument", "Invalid role: " + role);
    }

    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        return { success: true, pending: true, email, role };
      }
      throw new HttpsError("internal", "Lookup failed");
    }

    const current = (user.customClaims && user.customClaims.role) || null;
    if (current === role) {
      return { success: true, pending: false, unchanged: true, email, role };
    }
    await auth.setCustomUserClaims(user.uid, { role });
    return { success: true, pending: false, email, role, previous: current };
  }
);

// ── Admin: one-off migration for the existing population ──
// Walks every profile and stamps the claim from the stored role. Safe to
// re-run: accounts already holding the right claim are counted, not
// rewritten (a needless setCustomUserClaims would churn tokens for no
// reason). Run this BEFORE removing noRoleYet() from firestore.rules —
// removing the escape hatch first locks out everyone at once.
exports.backfillUserRoles = onCall(
  { region: "us-central1" },
  async (request) => {
    const auth = getAuth();
    await assertAdminOrBootstrap(request, auth);

    const dryRun = !!(request.data && request.data.dryRun);
    const db = getFirestore();
    const users = await loadProfiles(db);

    const report = {
      dryRun,
      total: 0,
      stamped: 0,
      alreadyCorrect: 0,
      noAuthAccount: 0,
      noEmail: 0,
      invalidRole: 0,
      errors: 0,
      details: [],
    };

    for (const key of Object.keys(users)) {
      const u = users[key];
      if (!u) continue;
      report.total++;

      const email = String((u.email || "")).trim().toLowerCase();
      const role = u.role || "worker";

      if (!email) {
        report.noEmail++;
        report.details.push({ username: key, result: "no-email" });
        continue;
      }
      if (!VALID_ROLES.includes(role)) {
        report.invalidRole++;
        report.details.push({ username: key, email, result: "invalid-role", role });
        continue;
      }

      try {
        const user = await auth.getUserByEmail(email);
        const current = (user.customClaims && user.customClaims.role) || null;
        if (current === role) {
          report.alreadyCorrect++;
          continue;
        }
        if (!dryRun) {
          await auth.setCustomUserClaims(user.uid, { role });
        }
        report.stamped++;
        report.details.push({ username: key, email, result: "stamped", from: current, to: role });
      } catch (err) {
        if (err.code === "auth/user-not-found") {
          report.noAuthAccount++;
          report.details.push({ username: key, email, result: "no-auth-account", role });
        } else {
          report.errors++;
          report.details.push({ username: key, email, result: "error", message: err.message });
        }
      }
    }

    return report;
  }
);

// ── Self-service: claim-less user picks up their own low tier at login ──
// Covers the ordinary onboarding race: an admin adds the profile, the
// person then registers, and at that moment no admin is present to stamp
// them. Deliberately capped at worker/viewer — see the ESCALATION NOTE
// above. A profile claiming operator/admin returns pending:true and waits
// for a real admin action; it never self-elevates.
// Never downgrades or overwrites an existing claim.
exports.claimSelfFromProfile = onCall(
  { region: "us-central1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const fb = request.auth.token.firebase || {};
    if (fb.sign_in_provider === "phone") {
      throw new HttpsError("permission-denied", "Temporary recovery session");
    }
    if (request.auth.token.role) {
      return { changed: false, role: request.auth.token.role, reason: "already-claimed" };
    }

    const email = request.auth.token.email;
    if (!email) {
      return { changed: false, role: null, reason: "no-email-on-token" };
    }

    const db = getFirestore();
    const profile = findProfileByEmail(await loadProfiles(db), email);
    if (!profile) {
      return { changed: false, role: null, reason: "no-profile" };
    }

    const role = profile.role || "worker";
    if (!SELF_GRANTABLE.includes(role)) {
      // operator/admin must be granted by an admin, not claimed.
      return { changed: false, role: null, pending: true, reason: "needs-admin" };
    }

    await getAuth().setCustomUserClaims(request.auth.uid, { role });
    return { changed: true, role };
  }
);

// ═══════════════════════════════════════════
// 3. TALGIL PROXY — with auth verification
// ═══════════════════════════════════════════

// ══════════════════════════════════════════
// GOV DATA PROXY — data.gov.il (Ministry of Agriculture pesticide registry)
// ══════════════════════════════════════════
//
// The registry's CKAN API is public but its CORS behaviour is not dependable
// from a browser origin, and when it refuses the browser cannot tell us why.
// The app calls this only after a direct attempt fails.
//
// Read-only and host-locked: the URL must be a data.gov.il API address, so
// this cannot be turned into an open relay.

exports.govDataProxy = onRequest(
  { region: "us-central1", maxInstances: 5 },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "https://shorashim-plus.web.app");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }

    const raw = req.query.url;
    if (!raw) { res.status(400).json({ error: "Missing url" }); return; }

    let target;
    try {
      target = new URL(raw);
    } catch (err) {
      res.status(400).json({ error: "Malformed url" }); return;
    }
    if (target.protocol !== "https:" || target.hostname !== "data.gov.il") {
      res.status(400).json({ error: "Only https://data.gov.il is allowed" }); return;
    }
    if (!target.pathname.startsWith("/api/")) {
      res.status(400).json({ error: "Only /api/ paths are allowed" }); return;
    }

    try {
      const response = await fetch(target.toString(), {
        headers: { "Accept": "application/json" }
      });
      const text = await response.text();
      if (!response.ok) {
        res.status(response.status).json({ error: `data.gov.il ${response.status}`, detail: text.slice(0, 400) });
        return;
      }
      res.set("Cache-Control", "public, max-age=1800");
      res.type("application/json").send(text);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }
);

exports.talgilProxy = onRequest(
  { region: "us-central1", maxInstances: 5 },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "https://shorashim-plus.web.app");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    // Verify Firebase auth token
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing auth token" });
      return;
    }
    try {
      await getAuth().verifyIdToken(authHeader.split("Bearer ")[1]);
    } catch (err) {
      res.status(401).json({ error: "Invalid auth token" });
      return;
    }

    const { host, controllerId, user, pass, apiKey, endpoint, filter } = req.body || {};
    if (!host || !controllerId || !endpoint) {
      res.status(400).json({ error: "Missing host, controllerId, or endpoint" });
      return;
    }

    // Only allow calls to known Talgil servers
    if (!host.endsWith("talgil.com")) {
      res.status(400).json({ error: "Invalid host" });
      return;
    }

    let url = `https://${host}/api/targets/${controllerId}/${endpoint}`;
    if (filter) url += `?filter=${filter}`;

    try {
      const response = await fetch(url, {
        headers: {
          "Authorization": "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
          "TLG-API-Key": apiKey || ""
        }
      });
      if (!response.ok) {
        const text = await response.text();
        res.status(response.status).json({ error: `Talgil ${response.status}`, detail: text });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════
// 4. RECOVER ACCOUNT — SMS-verified credential recovery
//    Caller must be signed in with the PHONE provider (temp session from
//    signInWithPhoneNumber on the login screen). Matches the verified
//    phone against the registered phone in appData/shorashim-users,
//    resets the password, returns the login email/username, and deletes
//    the temporary phone-auth user. Rules block phone sessions from all
//    Firestore access; this function uses the Admin SDK.
// ═══════════════════════════════════════════

exports.recoverAccount = onCall(
  { region: "us-central1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Phone verification required");
    }
    const fb = request.auth.token.firebase || {};
    const phone = request.auth.token.phone_number;
    if (fb.sign_in_provider !== "phone" || !phone) {
      throw new HttpsError("permission-denied", "Phone verification required");
    }
    const newPassword = (request.data && request.data.newPassword) || "";
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      throw new HttpsError("invalid-argument", "Password must be at least 6 characters");
    }

    // Normalize both sides to E.164 (+972...) before comparing
    const normalize = (p) => {
      p = String(p || "").replace(/[\s\-().]/g, "");
      if (!p) return "";
      if (p.startsWith("+")) return p;
      if (p.startsWith("972")) return "+" + p;
      if (p.startsWith("0")) return "+972" + p.slice(1);
      return "+972" + p;
    };

    const db = getFirestore();
    const doc = await db.collection("appData").doc("shorashim-users").get();
    const users = (doc.exists && doc.data().value) || {};
    const match = Object.values(users).find(
      (u) => u && u.phone && normalize(u.phone) === phone
    );
    if (!match || !match.email) {
      throw new HttpsError("not-found", "Phone number not registered");
    }

    const auth = getAuth();
    let target;
    try {
      target = await auth.getUserByEmail(match.email);
      await auth.updateUser(target.uid, { password: newPassword });
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        // User was added by admin but never logged in — onboard via SMS
        target = await auth.createUser({ email: match.email, password: newPassword });
      } else {
        throw new HttpsError("internal", "Password update failed");
      }
    }

    // Best-effort cleanup + audit trail
    try { await auth.deleteUser(request.auth.uid); } catch (e) { /* ignore */ }
    try {
      await db.collection("audit-log").doc(`${Date.now()}_${match.username}_recover`).set({
        ts: Date.now(),
        actor: match.username,
        actorName: match.name || match.username,
        actorRole: match.role || "unknown",
        action: "recover",
        target: "auth",
        targetId: target.uid,
        targetUser: match.username,
        before: null,
        after: { method: "sms", phone },
        reason: "SMS credential recovery",
        userAgent: "cloud-function",
        online: true,
      });
    } catch (e) { /* ignore */ }

    return { email: match.email, username: match.username, name: match.name || "" };
  }
);


// ═══════════════════════════════════════════
// 5. PLAN EXTRACT — read an engineer's drawing / professional document
//    that was uploaded to Storage (build-plans/{pid}/…) and return the
//    structural elements it specifies, in the shape buildplan-plan.js
//    stores them. The model is forced to answer through a tool with a
//    strict schema, so the client never parses free text.
//
//    COST  Runs only when a staff user presses "read" on a document; the
//    result is cached by the client per document. Default model is the
//    cheapest vision-capable one; 'sonnet' is opt-in per call for a sheet
//    the small model misread. The key never reaches the browser.
// ═══════════════════════════════════════════

// Reading a 1:50 sheet is the hardest vision task in the app, and the model
// tier decides what it is physically able to see. Claude 4.7 and later are
// on the high-resolution tier: 2576 px on the long edge and 4784 visual
// tokens, against 1568 px / 1568 tokens for everything earlier. That is ~1.6x
// the linear detail — the difference between "IPN 160" and a grey smudge.
// The old pinned pair were both on the standard tier.
// Keys are stored on the document as d.model; old values keep working.
const PLAN_MODELS = {
  haiku:      "claude-haiku-4-5",      // cheapest, standard tier
  sonnet:     "claude-sonnet-4-5",     // legacy — kept so old reads still name their model
  "sonnet-5": "claude-sonnet-5",       // high-resolution tier
  opus:       "claude-opus-5",         // high-resolution tier
  "opus-5.5": "claude-opus-5-5"        // high-resolution tier, strongest
};

const PLAN_TOOL = {
  name: "report_plan",
  description: "Report every structural element and instruction found in the document.",
  input_schema: {
    type: "object",
    properties: {
      sheet: {
        type: "object",
        properties: {
          engineer:  { type: "string", description: "Engineer / office name, as printed" },
          drawingNo: { type: "string" },
          date:      { type: "string" },
          concrete:  { type: "string", description: "Concrete grade as written, e.g. ב-30. Empty if absent." },
          title:     { type: "string", description: "What the document is (foundation plan, BOQ, detail sheet…)" },
          summary:   { type: "string", description: "3-5 sentences in Hebrew: what this document specifies and for what structure." }
        },
        required: ["summary"]
      },
      elements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind:  { type: "string", enum: ["pad", "pier", "strip", "column", "beam", "slab"],
                     description: "pad=יסוד בודד, pier=כלונס, strip=קורת יסוד/יסוד עובר, column=עמוד בטון, beam=קורה, slab=רצפה/משטח" },
            name:  { type: "string", description: "The mark on the drawing, e.g. י-1, ק-2, F1" },
            count: { type: "integer", description: "How many of this element the drawing shows or schedules" },
            w:     { type: "number", description: "Width or diameter in METRES" },
            l:     { type: "number", description: "Length / second side in METRES (span for strip/beam). Omit for pier/slab." },
            h:     { type: "number", description: "Concrete depth/height/thickness in METRES" },
            below: { type: "number", description: "Top of element below finished ground, METRES. 0 if at grade." },
            area:  { type: "number", description: "Slab area in m² (slab only)" },
            topN:  { type: "integer", description: "Top longitudinal bars (strip/beam)" },
            botN:  { type: "integer", description: "Bottom longitudinal bars (strip/beam)" },
            starter: { type: "number", description: "Projecting dowel (קוצים) length in METRES, 0 if none" },
            plate: { type: "boolean", description: "True if an anchor plate / anchor bolts for a steel column are shown" },
            blind: { type: "boolean", description: "True if lean concrete (בטון רזה) is specified under it" },
            rebar: {
              type: "object",
              properties: {
                mainN:  { type: "integer", description: "Number of longitudinal bars in a cage (pad/pier/column)" },
                mainD:  { type: "integer", description: "Longitudinal bar diameter, mm" },
                stirD:  { type: "integer", description: "Stirrup/tie diameter, mm" },
                stirSp: { type: "number",  description: "Stirrup spacing, CM" },
                cover:  { type: "number",  description: "Concrete cover, CM" },
                mat:    { type: "boolean", description: "Bottom mat present (pad)" },
                matD:   { type: "integer", description: "Bottom mat bar diameter, mm" },
                matSp:  { type: "number",  description: "Bottom mat spacing, CM" },
                slabMesh: { type: "string", enum: ["Q188", "deformed", "none"], description: "Slab mesh type" },
                meshD:  { type: "integer", description: "Slab deformed-bar diameter, mm" },
                meshSp: { type: "number",  description: "Slab bar spacing, CM" }
              }
            },
            notes: { type: "string", description: "Anything else specified for this element, in Hebrew, verbatim where possible" },
            confidence: { type: "string", enum: ["high", "medium", "low"],
                          description: "high = read directly from a schedule/detail; low = inferred or partly illegible" },
            source: { type: "string", description: "Where on the document: page/sheet/detail reference" }
          },
          // Only what every element genuinely has. Numbers are optional ON
          // PURPOSE: a required number the drawing does not show gets
          // invented, and an invented footing size reaches a quote.
          required: ["kind", "name", "confidence"]
        }
      },
      structure: {
        type: "object",
        description: "The building frame as a whole — ONLY if the document shows a plan, sections or elevations of the structure (column grid, roof, steel sections). Omit entirely for a document that details only foundations.",
        properties: {
          present:     { type: "boolean" },
          lines:       { type: "integer", description: "Number of column LINES across the span (rows of columns, e.g. A/B/C = 3)" },
          colsPerLine: { type: "integer", description: "Columns along each line (e.g. A1..A5 = 5)" },
          bay:         { type: "number",  description: "Spacing between frames along the length, METRES" },
          length:      { type: "number",  description: "Overall length along the column lines, METRES" },
          span:        { type: "number",  description: "Overall width across the column lines, METRES" },
          eaves:       { type: "number",  description: "Column height at the low / eaves side, METRES" },
          ridge:       { type: "number",  description: "Height at the high side or ridge, METRES" },
          roofType:    { type: "string",  enum: ["mono", "gable", "flat"] },
          slope:       { type: "number",  description: "Roof slope in DEGREES (convert % or ratio)" },
          colProfile:    { type: "string", description: "Column section as written, e.g. RHS 120/120/5" },
          rafterProfile: { type: "string", description: "Rafter / roof beam section as written, e.g. IPN 160" },
          purlinProfile: { type: "string", description: "Purlin section as written" },
          purlinSp:      { type: "number", description: "Purlin spacing, METRES" },
          girtProfile:   { type: "string", description: "Wall rail section, if any" },
          braceMember:   { type: "string", description: "Wind-bracing member as written, e.g. cable 8mm, RHS 80/80/4" },
          cornerBrace:   { type: "string", description: "Knee / corner brace section, if drawn" },
          basePlate:     { type: "string", description: "Base plate as written, e.g. 250/250/12" },
          anchorBolts:   { type: "string", description: "Anchor bolts / dowels as written, e.g. 4Ø20" },
          roofClad:      { type: "string" },
          notes:         { type: "string", description: "Anything else about the frame, Hebrew" },
          confidence:    { type: "string", enum: ["high", "medium", "low"] }
        }
      },
      frame: {
        type: "object",
        description: "The building frame as a GRID of named axes and the members on it. Fill it whenever the document shows a plan, sections or elevations of the structure. Every number optional: omit what you cannot actually read.",
        properties: {
          axesX: {
            type: "array",
            description: "Axes along the LENGTH, usually numbered (1,2,3,4,5), in order. pos = distance in METRES from the first axis, accumulated from the dimension chain (350 350 350 350 -> 0, 3.5, 7, 10.5, 14).",
            items: { type: "object", properties: { name: { type: "string" }, pos: { type: "number" } }, required: ["name"] }
          },
          axesY: {
            type: "array",
            description: "Column LINES across the width, usually lettered (A,B,C), in order. pos in METRES from the first line (700 700 -> 0, 7, 14). Count the lines from the grid bubbles and the foundation plan (A1..A5, B1..B5, C1..C5 = 3 lines).",
            items: { type: "object", properties: { name: { type: "string" }, pos: { type: "number" } }, required: ["name"] }
          },
          totalX: { type: "number", description: "The overall dimension printed on the length chain, METRES (e.g. 1400 -> 14). Used to check the chain." },
          totalY: { type: "number", description: "The overall dimension printed on the width chain, METRES." },
          heights: {
            type: "array",
            description: "Top-of-column height above ground for each lettered line, METRES, read from the sections (e.g. A 5.50, C 5.00 on a mono-pitch). Include a middle line only if its height is printed or clearly on the slope.",
            items: { type: "object", properties: { line: { type: "string" }, h: { type: "number" } }, required: ["line"] }
          },
          sections: {
            type: "object",
            description: "The steel section label for each member ROLE, exactly as written on the drawing.",
            properties: {
              column:    { type: "string", description: "Typical column, e.g. RHS 120/120/5" },
              mainBeam:  { type: "string", description: "Beam / rafter running across the column lines, e.g. IPN 160" },
              edgeBeam:  { type: "string", description: "Beam along the outer lines between columns, e.g. IPN 120" },
              purlin:    { type: "string", description: "Purlin, e.g. P60-120/60/3.6" },
              kneeBrace: { type: "string", description: "Knee / diagonal brace (דיאגונל), e.g. RHS 80/80/4" },
              bracing:   { type: "string", description: "Roof or wall X-bracing, e.g. cable 8mm" }
            }
          },
          exceptions: {
            type: "array",
            description: "Individual elements whose section differs from their role's typical one — e.g. corner columns A1 and A5 labelled RHS 150/150/6.3 while the rest are RHS 120/120/5.",
            items: { type: "object", properties: {
              ref: { type: "string", description: "Grid node, e.g. A1" },
              role: { type: "string", enum: ["column"] },
              section: { type: "string" } }, required: ["ref", "section"] }
          },
          purlinSp:   { type: "number", description: "Purlin spacing, METRES (@100 -> 1.0)" },
          kneeDrop:   { type: "number", description: "How far below the column top the knee brace meets the column, METRES" },
          kneeRun:    { type: "number", description: "How far along the beam the knee brace meets it, METRES" },
          bracedBays: { type: "array", items: { type: "string" }, description: "Bays carrying X-bracing, as numbered-axis pairs, e.g. [\"1-2\", \"4-5\"]" },
          braceDepth: { type: "number", description: "Depth of the X-braced panel across the width from the outer line, METRES, if dimensioned" },
          footing: {
            type: "object",
            description: "The isolated footing (יסוד בודד), from the foundation detail.",
            properties: {
              w: { type: "number", description: "Footing width, METRES" },
              l: { type: "number", description: "Footing length, METRES" },
              t: { type: "number", description: "Footing thickness, METRES" },
              below: { type: "number", description: "Depth of the footing's TOP below ground, METRES" },
              ped: { type: "number", description: "Pedestal / neck (צוואר) side, METRES, if shown" },
              blind: { type: "number", description: "Lean concrete (בטון רזה) thickness, METRES" },
              plate: { type: "string", description: "Base plate, e.g. 250/250/12" },
              anchors: { type: "string", description: "Anchor bolts, e.g. 4Ø20" },
              count: { type: "integer", description: "Number of footings on the foundation plan" }
            }
          },
          evidence: {
            type: "array",
            items: { type: "string" },
            description: "For each number reported, the exact text read and which tile/view it came from, e.g. 'plan, tile r2c2: 350 350 350 350 = 1400 along A'."
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        }
      },
      other: {
        type: "array",
        description: "Every instruction, material or item that is NOT one of the element kinds above (steel columns, bolts, welds, soil notes, BOQ lines, general notes). One short Hebrew line each, verbatim where possible.",
        items: { type: "string" }
      },
      questions: {
        type: "array",
        description: "Things a non-builder should ask the engineer before building: ambiguities, missing dimensions, unusual requirements. Hebrew, one per item.",
        items: { type: "string" }
      }
    },
    required: ["sheet", "elements", "other", "questions"]
  }
};

const PLAN_SYSTEM = [
  "You are a senior structural engineer reading construction documents for a client who is not a builder.",
  "Read the whole document: plans, sections, details, schedules (טבלאות זיון), general notes and any BOQ.",
  "Report EVERY structural element with all dimensions and reinforcement exactly as written. Convert units:",
  "geometry to metres (a drawing saying 60/60/80 cm is w=0.6 l=0.6 h=0.8), bar diameters in mm, spacing and cover in cm.",
  "Israeli notation: 6Ø12 = six bars of 12 mm; חישוקים Ø8@20 = 8 mm stirrups every 20 cm; #Ø10@15 = 10 mm bars each way every 15 cm;",
  "ב-30 = concrete grade; Q188 = welded mesh; קוצים = starter dowels; בטון רזה = lean concrete; כיסוי = cover.",
  "If the document shows the frame (column grid, sections, roof), fill `structure`: count the column LINES across the width and the columns along each line from the grid marks (A1..A5, B1..B5, C1..C5 = 3 lines x 5), read the spacings off the dimension strings, the heights and slope off the sections, and every steel section label exactly as written.",
  "Never invent a value: if a number is not on the document, omit the field and lower the confidence.",
  "Fill `frame` for any sheet showing the structure: name every axis from its grid bubble, accumulate each axis position from the dimension chain, give each lettered line its column height from the sections, and put every steel label under its role. A single element labelled differently from its role (e.g. corner columns) goes in `exceptions`.",
  "When the document arrives as TILES: the first image of each page is an overview for layout only; the following tiles are overlapping full-resolution crops labelled with their position. Read every label and dimension from the tiles, not the overview. A label cut by a tile edge appears whole in the neighbouring tile. Report in `evidence` which tile each number came from.",
  "An empty field is correct. A guessed field is a defect: it will be priced and built.",
  "Mark text values (name, notes, other, questions, summary) in Hebrew.",
  "Answer only through the report_plan tool."
].join(" ");

exports.planExtract = onCall(
  { region: "us-central1", secrets: [ANTHROPIC_API_KEY], memory: "1GiB", timeoutSeconds: 300, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    const fb = tok.firebase || {};
    if (fb.sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    // operator/admin, or the transitional no-claim state that the Firestore
    // rules also accept (noRoleYet)
    if (tok.role !== undefined && tok.role !== null && !["admin", "operator"].includes(tok.role)) {
      throw new HttpsError("permission-denied", "Operator or admin required");
    }

    const { path, model, hint, tiles, name } = request.data || {};
    if (typeof path !== "string" || !/^build-plans\/\d+\/[^/]+$/.test(path)) {
      throw new HttpsError("invalid-argument", "path must be build-plans/{projectId}/{file}");
    }
    const modelId = PLAN_MODELS[model] || PLAN_MODELS.sonnet;
    // Tiles rendered in the browser. Bounded so one call cannot run away:
    // at most 20 images, each under 1.6 MB of base64, 9 MB in total (the
    // callable request limit is 10 MB).
    let tileBlocks = null;
    if (Array.isArray(tiles) && tiles.length) {
      if (tiles.length > 20) throw new HttpsError("invalid-argument", "At most 20 tiles");
      let total = 0;
      tileBlocks = [];
      for (const t of tiles) {
        const d = t && typeof t.data === "string" ? t.data : "";
        if (!d || d.length > 1.6 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(d.slice(0, 200))) {
          throw new HttpsError("invalid-argument", "Bad tile");
        }
        total += d.length;
        tileBlocks.push({ type: "text", text: String((t && t.label) || "tile").slice(0, 160) + ":" });
        tileBlocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } });
      }
      if (total > 9 * 1024 * 1024) throw new HttpsError("invalid-argument", "Tiles over 9 MB");
    }

    // Same bucket the client is configured with (public/index.html).
    const file = getStorage().bucket("shorashim-plus.firebasestorage.app").file(path);
    const [exists] = await file.exists();
    if (!exists) throw new HttpsError("not-found", "Document not found in storage");
    const [meta] = await file.getMetadata();
    const size = Number(meta.size) || 0;
    const ctype = String(meta.contentType || "");
    const isPdf = ctype === "application/pdf" || /\.pdf$/i.test(path);
    if (isPdf && size > 30 * 1024 * 1024) throw new HttpsError("invalid-argument", "PDF over 30 MB");
    if (!isPdf && size > 5 * 1024 * 1024) throw new HttpsError("invalid-argument", "Image over 5 MB — the app downsizes on upload; re-upload it");
    if (!isPdf && !/^image\/(jpeg|png|webp|gif)$/.test(ctype)) throw new HttpsError("invalid-argument", "Unsupported type " + ctype);

    let blocks;
    if (tileBlocks) {
      // The file was already checked above to exist and belong to the
      // project's folder; the tiles are what the model reads.
      blocks = tileBlocks;
    } else {
      const [buf] = await file.download();
      const data = buf.toString("base64");
      blocks = [isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: ctype, data } }];
    }

    const userText = "Read this construction document and report it through the tool." +
      (tileBlocks ? " It arrives as tiles: overview first, then full-resolution crops." : "") +
      (typeof name === "string" && name.trim() ? " File name: " + name.trim().slice(0, 160) + "." : "") +
      (typeof hint === "string" && hint.trim() ? " Context from the client: " + hint.trim().slice(0, 600) : "");

    let res, text;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 12000,
          system: PLAN_SYSTEM,
          tools: [PLAN_TOOL],
          tool_choice: { type: "tool", name: "report_plan" },
          messages: [{ role: "user", content: blocks.concat([{ type: "text", text: userText }]) }]
        })
      });
      text = await res.text();
    } catch (err) {
      throw new HttpsError("unavailable", "Model call failed: " + err.message);
    }
    if (!res.ok) {
      throw new HttpsError("internal", "Model " + res.status + ": " + text.slice(0, 300));
    }
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new HttpsError("internal", "Bad model response"); }
    const call = (body.content || []).find((b) => b.type === "tool_use" && b.name === "report_plan");
    if (!call || !call.input) throw new HttpsError("internal", "Model returned no report");

    return {
      report: call.input,
      model: modelId,
      usage: body.usage ? { input: body.usage.input_tokens, output: body.usage.output_tokens } : null,
      at: Date.now()
    };
  }
);
