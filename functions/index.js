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

    // Forcing the tool ({ type: "tool" }) is the reliable way to get a
    // structured answer, and every model here accepted it until Opus 5.5:
    // forced tool use now returns an error there, and thinking cannot be
    // switched off, so the reply carries thinking blocks and needs more room.
    // Those models are asked rather than forced, and the prompt already says
    // to answer through the tool. Anything unlisted keeps the old behaviour.
    function noForcedTools(id) { return /^claude-(opus-5-5|fable-|mythos-)/.test(id); }
    function reqBody(id, blocks, userText) {
      const soft = noForcedTools(id);
      return {
        model: id,
        max_tokens: soft ? 24000 : 12000,
        system: PLAN_SYSTEM + (soft ? "\n\nAnswer ONLY by calling the report_plan tool. Do not reply with prose." : ""),
        tools: [PLAN_TOOL],
        tool_choice: soft ? { type: "auto" } : { type: "tool", name: "report_plan" },
        messages: [{ role: "user", content: blocks.concat([{ type: "text", text: userText }]) }]
      };
    }

    let res, text;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(reqBody(modelId, blocks, userText))
      });
      text = await res.text();
    } catch (err) {
      throw new HttpsError("unavailable", "Model call failed: " + err.message);
    }
    if (!res.ok) {
      // The API's own message, verbatim — an unknown model id, a rejected
      // parameter and an exhausted credit balance all used to look the same
      // on screen.
      let why = text.slice(0, 300);
      try { const e = JSON.parse(text); if (e && e.error && e.error.message) why = e.error.message; } catch (e) {}
      throw new HttpsError("internal", modelId + " \u2014 " + res.status + ": " + why);
    }
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new HttpsError("internal", "Bad model response"); }
    const call = (body.content || []).find((b) => b.type === "tool_use" && b.name === "report_plan");
    if (!call || !call.input) {
      // Asked rather than forced, a model can answer in prose instead. Say so
      // plainly, with what it did say, instead of "no report".
      const said = (body.content || []).filter((b) => b.type === "text")
        .map((b) => b.text).join(" ").slice(0, 200);
      throw new HttpsError("internal", modelId + " \u2014 " +
        (said ? "answered in text instead of the report tool: " + said : "returned no report"));
    }

    return {
      report: call.input,
      model: modelId,
      usage: body.usage ? { input: body.usage.input_tokens, output: body.usage.output_tokens } : null,
      at: Date.now()
    };
  }
);

// ── plotDetect ─────────────────────────────────────────────────────────
// Reads a farm image (satellite screenshot, drawn map, hand sketch) and
// returns candidate plot outlines in IMAGE PIXELS. It knows nothing about
// geography: plotimport.js aligns the image on the map and projects the
// pixels itself, so the model is only ever asked what it can see.
//
// The image arrives inline, downscaled in the browser (long side <= 1568 px,
// which is what the vision models read at native resolution), so nothing is
// written to Storage. Called only on an explicit press; the browser caches
// the answer per image, so re-opening the same screenshot costs nothing.
const PLOT_TOOL = {
  name: "report_plots",
  description: "Report every agricultural plot visible in the image as a polygon in image pixel coordinates.",
  input_schema: {
    type: "object",
    properties: {
      imageKind: { type: "string", enum: ["satellite", "map", "sketch", "photo", "other"] },
      plots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Name or number written on or inside the plot, verbatim. Empty string if none." },
            points: {
              type: "array",
              description: "Outer boundary vertices as [x, y] in PIXELS of the image exactly as sent: origin top-left, x to the right, y downward. In order around the boundary, 4 to 40 points, on the real corners. Do not repeat the first point at the end.",
              items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }
            },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            note: { type: "string", description: "Short Hebrew note, only if something about this outline is uncertain." }
          },
          required: ["points", "confidence"]
        }
      },
      notes: { type: "string", description: "Short Hebrew remark about the image as a whole, if needed." }
    },
    required: ["plots"]
  }
};

const PLOT_SYSTEM = [
  "You map agricultural plots for a farm-management app (date palm orchards, orchards, fields, greenhouses).",
  "A plot is one contiguous cultivated block. Its edges are roads, dirt tracks, fences, windbreaks, ditches, drawn lines, or a clear change of crop, colour or texture.",
  "Satellite image: trace each planted block along the outer line of its trees or crop. Two blocks separated by a track are two plots.",
  "Drawn map or sketch: trace the drawn outlines; read any name or number written in each.",
  "Do not report roads, buildings, reservoirs, yards or bare land unless the user's hint asks for them.",
  "Coordinates are pixels of the image exactly as sent; its width and height are given. Put vertices on the real corners; fewer accurate vertices beat many vague ones.",
  "Never invent a plot you cannot see. An empty list is a correct answer for an image without plots.",
  "Answer only through the report_plots tool."
].join(" ");

exports.plotDetect = onCall(
  { region: "us-central1", secrets: [ANTHROPIC_API_KEY], memory: "512MiB", timeoutSeconds: 180, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    const fb = tok.firebase || {};
    if (fb.sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    // Same tier that may write plots (plotMapperSprayData is operator+ in
    // firestore.rules). Every account carries a role claim now.
    if (!["admin", "operator"].includes(tok.role)) {
      throw new HttpsError("permission-denied", "Operator or admin required");
    }

    const { image, width, height, model, hint } = request.data || {};
    const W = Math.round(Number(width)), H = Math.round(Number(height));
    if (!(W >= 32 && W <= 4000 && H >= 32 && H <= 4000)) throw new HttpsError("invalid-argument", "Bad image size");
    if (typeof image !== "string" || !image || image.length > 3 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) {
      throw new HttpsError("invalid-argument", "Bad image");
    }
    const allowed = ["haiku", "sonnet-5", "opus", "opus-5.5"];
    const key = allowed.includes(model) ? model : "sonnet-5";
    const modelId = PLAN_MODELS[key];
    const soft = /^claude-(opus-5-5|fable-|mythos-)/.test(modelId);

    const userText = "Image size: " + W + " x " + H + " pixels. Report every plot through the tool." +
      (typeof hint === "string" && hint.trim() ? " Context from the farmer: " + hint.trim().slice(0, 400) : "");

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
          max_tokens: soft ? 16000 : 8000,
          system: PLOT_SYSTEM + (soft ? "\n\nAnswer ONLY by calling the report_plots tool. Do not reply with prose." : ""),
          tools: [PLOT_TOOL],
          tool_choice: soft ? { type: "auto" } : { type: "tool", name: "report_plots" },
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: userText }
          ] }]
        })
      });
      text = await res.text();
    } catch (err) {
      throw new HttpsError("unavailable", "Model call failed: " + err.message);
    }
    if (!res.ok) {
      let why = text.slice(0, 300);
      try { const e = JSON.parse(text); if (e && e.error && e.error.message) why = e.error.message; } catch (e) {}
      throw new HttpsError("internal", modelId + " \u2014 " + res.status + ": " + why);
    }
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new HttpsError("internal", "Bad model response"); }
    const call = (body.content || []).find((b) => b.type === "tool_use" && b.name === "report_plots");
    if (!call || !call.input) {
      const said = (body.content || []).filter((b) => b.type === "text")
        .map((b) => b.text).join(" ").slice(0, 200);
      throw new HttpsError("internal", modelId + " \u2014 " +
        (said ? "answered in text instead of the tool: " + said : "returned no plots"));
    }

    // Clamp to the image and bound the size of what goes back, so a
    // confused answer cannot put a vertex off the image or bloat the plot doc.
    const clamp = (v, hi) => Math.max(0, Math.min(hi, Number(v) || 0));
    const plots = (Array.isArray(call.input.plots) ? call.input.plots : []).slice(0, 60).map((p) => ({
      label: typeof p.label === "string" ? p.label.slice(0, 60) : "",
      confidence: ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "low",
      note: typeof p.note === "string" ? p.note.slice(0, 200) : "",
      points: (Array.isArray(p.points) ? p.points : []).slice(0, 80)
        .filter((q) => Array.isArray(q) && q.length >= 2)
        .map((q) => [clamp(q[0], W), clamp(q[1], H)])
    })).filter((p) => p.points.length >= 3);

    return {
      plots,
      imageKind: call.input.imageKind || "other",
      notes: typeof call.input.notes === "string" ? call.input.notes.slice(0, 300) : "",
      model: modelId,
      usage: body.usage ? { input: body.usage.input_tokens, output: body.usage.output_tokens } : null,
      at: Date.now()
    };
  }
);

// ── plotDataExtract ────────────────────────────────────────────────────
// Reads a table of plot data (a photo, a screenshot or a PDF: plot lists,
// lease schedules, Plant Protection Service forms) into rows for the plot
// register (plotregister.js). It reads ATTRIBUTES only — names, areas,
// varieties, tree counts. The outline is still drawn by hand on the map;
// the row is then applied to the drawn polygon in one press.
const PLOT_ROWS_TOOL = {
  name: "report_plot_rows",
  description: "Report every plot row found in the document.",
  input_schema: {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            plot_no:          { type: "string",  description: "Plot number / identifier exactly as written (e.g. 12, 7א, B-3). Empty if none." },
            name:             { type: "string",  description: "Plot name as written. Empty if the row has only a number." },
            farm:             { type: "string",  description: "Farm / orchard / moshav / block the row belongs to, as written. Empty if none." },
            area:             { type: "number",  description: "Area in DUNAM. Convert: hectare x10, m2 /1000, acre x4.047. Omit if absent." },
            variety:          { type: "string",  description: "Cultivar / variety (זן), e.g. מג'הול, ברהי, דקל נור. As written." },
            crop:             { type: "string",  description: "Crop type (גידול), e.g. תמרים. As written." },
            tree_count:       { type: "integer", description: "Number of trees / plants. Omit if absent." },
            missing_trees:    { type: "integer", description: "Missing trees / gaps (עצים חסרים, חוסרים). Omit if absent." },
            young_trees:      { type: "integer", description: "Young / replanted trees (עצים צעירים, השלמות). Omit if absent." },
            row_spacing:      { type: "number",  description: "Spacing between rows, METRES." },
            tree_spacing:     { type: "number",  description: "Spacing between trees in a row, METRES." },
            plants_per_dunam: { type: "number" },
            planting_year:    { type: "integer", description: "Year planted, 4 digits." },
            notes:            { type: "string",  description: "Free-text remarks in the row, verbatim." },
            extra:            { type: "array", items: { type: "string" }, description: "Any other column of this row as 'header: value', e.g. 'מס' גוש: 30012'." },
            confidence:       { type: "string",  enum: ["high", "medium", "low"] }
          },
          required: ["confidence"]
        }
      },
      notes: { type: "string", description: "Short Hebrew remark about the document, if needed (e.g. a page was unreadable)." }
    },
    required: ["rows"]
  }
};

const PLOT_ROWS_SYSTEM = [
  "You read agricultural plot tables for a farm-management app: plot lists, lease schedules, orchard registers, agronomist reports, handwritten notes.",
  "Return ONE row per plot. A plot is identified by its number and/or name. Totals, subtotals and header lines are not plots.",
  "Copy names, numbers and varieties exactly as written, in their original language. Convert areas to dunam and spacings to metres.",
  "A value that is not on the document is omitted, never guessed. A merged or repeated cell (e.g. a farm name spanning several rows) applies to every row it spans.",
  "Columns that do not fit a field go into `extra` as 'header: value'.",
  "Answer only through the report_plot_rows tool."
].join(" ");

exports.plotDataExtract = onCall(
  { region: "us-central1", secrets: [ANTHROPIC_API_KEY], memory: "1GiB", timeoutSeconds: 300, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    const fb = tok.firebase || {};
    if (fb.sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (!["admin", "operator"].includes(tok.role)) {
      throw new HttpsError("permission-denied", "Operator or admin required");
    }

    const { image, pdf, model, hint, farms } = request.data || {};
    const b64ok = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max &&
      /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 200));
    let block;
    if (pdf) {
      if (!b64ok(pdf, 9 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad or oversized PDF (max ~6.5 MB)");
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } };
    } else {
      if (!b64ok(image, 3 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad image");
      block = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } };
    }
    const allowed = ["haiku", "sonnet-5", "opus", "opus-5.5"];
    const modelId = PLAN_MODELS[allowed.includes(model) ? model : "sonnet-5"];
    const soft = /^claude-(opus-5-5|fable-|mythos-)/.test(modelId);

    const farmList = Array.isArray(farms)
      ? farms.filter((f) => typeof f === "string").map((f) => f.slice(0, 60)).slice(0, 60) : [];
    const userText = "Report every plot row in this document through the tool." +
      (farmList.length ? " Farms that exist in the app (use these spellings when a row clearly refers to one): " + farmList.join(", ") + "." : "") +
      (typeof hint === "string" && hint.trim() ? " Context from the farmer: " + hint.trim().slice(0, 400) : "");

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
          max_tokens: soft ? 24000 : 16000,
          system: PLOT_ROWS_SYSTEM + (soft ? "\n\nAnswer ONLY by calling the report_plot_rows tool. Do not reply with prose." : ""),
          tools: [PLOT_ROWS_TOOL],
          tool_choice: soft ? { type: "auto" } : { type: "tool", name: "report_plot_rows" },
          messages: [{ role: "user", content: [block, { type: "text", text: userText }] }]
        })
      });
      text = await res.text();
    } catch (err) {
      throw new HttpsError("unavailable", "Model call failed: " + err.message);
    }
    if (!res.ok) {
      let why = text.slice(0, 300);
      try { const e = JSON.parse(text); if (e && e.error && e.error.message) why = e.error.message; } catch (e) {}
      throw new HttpsError("internal", modelId + " \u2014 " + res.status + ": " + why);
    }
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new HttpsError("internal", "Bad model response"); }
    const call = (body.content || []).find((b) => b.type === "tool_use" && b.name === "report_plot_rows");
    if (!call || !call.input) {
      const said = (body.content || []).filter((b) => b.type === "text")
        .map((b) => b.text).join(" ").slice(0, 200);
      throw new HttpsError("internal", modelId + " \u2014 " +
        (said ? "answered in text instead of the tool: " + said : "returned no rows"));
    }

    // Bounded and typed before it reaches the browser and the register doc.
    const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const num = (v, lo, hi) => { const x = Number(v); return isFinite(x) && x >= lo && x <= hi ? x : null; };
    const rows = (Array.isArray(call.input.rows) ? call.input.rows : []).slice(0, 400).map((r) => ({
      plot_no: str(r.plot_no, 30),
      name: str(r.name, 80),
      farm: str(r.farm, 60),
      area: num(r.area, 0.01, 100000),
      variety: str(r.variety, 60),
      crop: str(r.crop, 60),
      tree_count: num(r.tree_count, 0, 1000000),
      missing_trees: num(r.missing_trees, 0, 1000000),
      young_trees: num(r.young_trees, 0, 1000000),
      row_spacing: num(r.row_spacing, 0.5, 30),
      tree_spacing: num(r.tree_spacing, 0.5, 30),
      plants_per_dunam: num(r.plants_per_dunam, 1, 100000),
      planting_year: num(r.planting_year, 1900, 2100),
      notes: str(r.notes, 300),
      extra: (Array.isArray(r.extra) ? r.extra : []).filter((x) => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 120)),
      confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low"
    })).filter((r) => r.plot_no || r.name);

    return {
      rows,
      notes: str(call.input.notes, 300),
      model: modelId,
      usage: body.usage ? { input: body.usage.input_tokens, output: body.usage.output_tokens } : null,
      at: Date.now()
    };
  }
);

// ═══════════════════════════════════════════
// INVENTORY EXTRACT — stock and equipment from a photo or document
// (Oct 2026). A farm's "document intake" mode is switched on by an admin
// (farm.doc_intake.enabled in appData/plotMapperSprayData); this function
// refuses any farm where it is off, so the switch is enforced here and not
// only in the UI. Operators must also hold a permission for the farm.
// Nothing is written: the items go back to the browser for the person to
// review before anything reaches the farm's stock or equipment.
// ═══════════════════════════════════════════
const INVENTORY_TOOL = {
  name: "report_inventory",
  description: "Report the document's header and every stock or equipment line in it.",
  input_schema: {
    type: "object",
    properties: {
      doc_type: { type: "string", enum: ["invoice", "delivery_note", "receipt", "equipment_photo", "product_photo", "stock_list", "equipment_transfer", "other"],
        description: "equipment_transfer = a document moving tools/machines between farms or sites (ניוד כלים)." },
      vat_included: { type: "boolean", description: "True if the line prices on this document include VAT (מע\"מ), false if before VAT. Default false for Israeli invoices that show a separate VAT line." },
      supplier: { type: "string", description: "Supplier / issuer name as written. Empty if none." },
      doc_date: { type: "string", description: "Document date as YYYY-MM-DD if legible, else empty." },
      doc_no:   { type: "string", description: "Invoice / delivery note number. Empty if none." },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["pesticide", "fertilizer", "equipment", "other"],
              description: "pesticide = crop-protection product (insecticide, fungicide, herbicide, acaricide, oil, adjuvant); fertilizer = fertilizer or nutrient; equipment = a machine, sprayer, vehicle or tool (not a consumable); other = any other consumable." },
            name: { type: "string", description: "Product or item name as written (Hebrew as written; keep trade names)." },
            product: { type: "string", description: "The generic product name without pack size, quantity or supplier code (e.g. 'טוטם', 'אשלגן כלורי', 'צינור טפטוף 16 מ\"מ'), so the same product groups across suppliers and pack sizes." },
            catalogue_match: { type: "string", description: "If kind is pesticide and the product is one of the catalogue names given, that exact catalogue name; else empty." },
            qty: { type: "number", description: "Total quantity delivered/owned in `unit` (multiply packs × pack size when both are shown). 1 for a single piece of equipment." },
            unit: { type: "string", description: "ליטר, ק\"ג, יחידה, שק, etc." },
            base_unit: { type: "string", enum: ["ליטר", "ק\"ג", "יחידה", "מטר", "טון", ""], description: "The unit a price is compared in: litres for liquids, kg for solids, unit for pieces, metre for pipe/wire." },
            unit_price: { type: "number", description: "Price in ₪ per ONE base_unit, BEFORE VAT (convert packs: a 5 L can at 450 ₪ → 90 per litre; remove VAT if the document's prices include it). 0 if no price on the document." },
            line_total: { type: "number", description: "Line total in ₪ as written on the document, 0 if none." },
            pack: { type: "string", description: "Pack description if shown (e.g. 'מיכל 5 ל׳'). Empty if none." },
            equipment_type: { type: "string", enum: ["sprayer", "vehicle", "tool", ""], description: "Only for equipment." },
            sprayer_kind: { type: "string", enum: ["airblast", "gun", "boom", "backpack", "drench", ""], description: "Only for sprayers: airblast (mist blower / תותח), gun (hose & gun / רובה), boom (מוט), backpack (גב), drench (הגמעה tank)." },
            capacity_l: { type: "number", description: "Sprayer tank volume in litres if shown, else 0." },
            notes: { type: "string", description: "Model, serial number, price or anything worth keeping. Short." },
            confidence: { type: "string", enum: ["high", "medium", "low"] }
          },
          required: ["kind", "name", "qty", "unit", "confidence"]
        }
      },
      notes: { type: "string", description: "Anything the reviewer should know (illegible parts, totals that do not add up). Short." }
    },
    required: ["doc_type", "items"]
  }
};
const INVENTORY_SYSTEM = [
  "You read Israeli farm documents — supplier invoices, delivery notes (תעודת משלוח), receipts, stock lists — and photos of products or equipment, and report what they add to a farm's stock and equipment.",
  "Report each line once. Skip lines that are services, transport, discounts, deposits or VAT. Quantities are what was supplied; prices go in unit_price (per base unit, before VAT) and line_total.",
  "Hebrew documents are right-to-left; read numbers carefully (a comma may be a thousands separator).",
  "For a photo of a single product or machine, report that one item (qty 1 for equipment; for a product container, qty = its labelled volume or weight).",
  "Prices: the net price actually paid per base unit after any per-line discount, before VAT. A delivery note usually has no prices — leave them 0.",
  "Never invent: leave a field empty or 0 when it is not on the document, and lower the confidence when unsure."
].join(" ");

exports.inventoryExtract = onCall(
  { region: "us-central1", secrets: [ANTHROPIC_API_KEY], memory: "1GiB", timeoutSeconds: 300, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    const fb = tok.firebase || {};
    if (fb.sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (!["admin", "operator"].includes(tok.role)) {
      throw new HttpsError("permission-denied", "Operator or admin required");
    }

    const { farmId, image, pdf, model, hint, catalogue } = request.data || {};
    const fid = Number(farmId);
    if (!Number.isFinite(fid) || fid <= 0) throw new HttpsError("invalid-argument", "farmId required");

    // The admin switch, read from the stored farm — not from the request.
    const db = getFirestore();
    const dataSnap = await db.collection("appData").doc("plotMapperSprayData").get();
    const farms = (dataSnap.exists && dataSnap.get("value.farms")) || [];
    const farm = Array.isArray(farms) ? farms.find((f) => f && Number(f.id) === fid) : null;
    if (!farm) throw new HttpsError("not-found", "Farm not found");
    if (!(farm.doc_intake && farm.doc_intake.enabled === true)) {
      throw new HttpsError("permission-denied", "Document intake is not enabled for this farm (admin approval required)");
    }
    if (tok.role !== "admin") {
      const usersSnap = await db.collection("appData").doc("shorashim-users").get();
      const users = (usersSnap.exists && usersSnap.get("value")) || {};
      const email = String(tok.email || "").toLowerCase();
      const me = Object.values(users).find((u) => u && String(u.email || "").toLowerCase() === email);
      const perms = (me && Array.isArray(me.farm_permissions)) ? me.farm_permissions.map(Number) : [];
      if (!perms.includes(fid)) throw new HttpsError("permission-denied", "No permission for this farm");
    }

    const b64ok = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max &&
      /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 200));
    let block;
    if (pdf) {
      if (!b64ok(pdf, 9 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad or oversized PDF (max ~6.5 MB)");
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } };
    } else {
      if (!b64ok(image, 4 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad or oversized image");
      block = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } };
    }
    const allowed = ["haiku", "sonnet-5", "opus", "opus-5.5"];
    const modelId = PLAN_MODELS[allowed.includes(model) ? model : "sonnet-5"];
    const soft = /^claude-(opus-5-5|fable-|mythos-)/.test(modelId);

    const cat = Array.isArray(catalogue)
      ? catalogue.filter((c) => typeof c === "string").map((c) => c.slice(0, 60)).slice(0, 300) : [];
    const userText = "Report this document through the tool." +
      (cat.length ? " Crop-protection products in the farm's catalogue (use these exact spellings for catalogue_match): " + cat.join(", ") + "." : "") +
      (typeof hint === "string" && hint.trim() ? " Context from the farmer: " + hint.trim().slice(0, 400) : "");

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
          max_tokens: soft ? 16000 : 8000,
          system: INVENTORY_SYSTEM + (soft ? "\n\nAnswer ONLY by calling the report_inventory tool. Do not reply with prose." : ""),
          tools: [INVENTORY_TOOL],
          tool_choice: soft ? { type: "auto" } : { type: "tool", name: "report_inventory" },
          messages: [{ role: "user", content: [block, { type: "text", text: userText }] }]
        })
      });
      text = await res.text();
    } catch (err) {
      throw new HttpsError("unavailable", "Model call failed: " + err.message);
    }
    if (!res.ok) {
      let why = text.slice(0, 300);
      try { const e = JSON.parse(text); if (e && e.error && e.error.message) why = e.error.message; } catch (e) {}
      throw new HttpsError("internal", modelId + " — " + res.status + ": " + why);
    }
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new HttpsError("internal", "Bad model response"); }
    const call = (body.content || []).find((b) => b.type === "tool_use" && b.name === "report_inventory");
    if (!call || !call.input) {
      const said = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").slice(0, 200);
      throw new HttpsError("internal", modelId + " — " + (said ? "answered in text instead of the tool: " + said : "returned no items"));
    }

    const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const num = (v, lo, hi) => { const x = Number(v); return isFinite(x) && x >= lo && x <= hi ? x : 0; };
    const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
    const items = (Array.isArray(call.input.items) ? call.input.items : []).slice(0, 200).map((r) => ({
      kind: oneOf(r.kind, ["pesticide", "fertilizer", "equipment", "other"], "other"),
      name: str(r.name, 100),
      product: str(r.product, 100),
      base_unit: oneOf(r.base_unit, ["ליטר", "ק\"ג", "יחידה", "מטר", "טון"], ""),
      unit_price: num(r.unit_price, 0, 10000000),
      line_total: num(r.line_total, 0, 100000000),
      catalogue_match: cat.includes(r.catalogue_match) ? r.catalogue_match : "",
      qty: num(r.qty, 0, 1000000),
      unit: str(r.unit, 20),
      pack: str(r.pack, 60),
      equipment_type: oneOf(r.equipment_type, ["sprayer", "vehicle", "tool"], ""),
      sprayer_kind: oneOf(r.sprayer_kind, ["airblast", "gun", "boom", "backpack", "drench"], ""),
      capacity_l: num(r.capacity_l, 0, 100000),
      notes: str(r.notes, 200),
      confidence: oneOf(r.confidence, ["high", "medium", "low"], "low")
    })).filter((r) => r.name);

    return {
      doc_type: oneOf(call.input.doc_type, ["invoice", "delivery_note", "receipt", "equipment_photo", "product_photo", "stock_list", "equipment_transfer", "other"], "other"),
      vat_included: call.input.vat_included === true,
      supplier: str(call.input.supplier, 80),
      doc_date: /^\d{4}-\d{2}-\d{2}$/.test(String(call.input.doc_date || "")) ? call.input.doc_date : "",
      doc_no: str(call.input.doc_no, 40),
      items,
      notes: str(call.input.notes, 300),
      model: modelId,
      usage: body.usage ? { input: body.usage.input_tokens, output: body.usage.output_tokens } : null,
      at: Date.now()
    };
  }
);

// ═══════════════════════════════════════════
// IMS WEATHER — nearest Israel Meteorological Service station per farm
// (Oct 2026, weather.js). The IMS Envista API needs a personal token
// (ims.gov.il/en/ObservationDataAPI); it is kept as a secret here, never in
// the browser. Set once with:
//   firebase functions:secrets:set IMS_TOKEN
// then deploy this function. Until then the weather tab shows the forecast
// only. Stations are cached for 12 h, latest readings for 10 min.
// ═══════════════════════════════════════════
const IMS_TOKEN = defineSecret("IMS_TOKEN");
const IMS_BASE = "https://api.ims.gov.il/v1/envista";
let _imsStations = null, _imsStationsAt = 0;
const _imsLatest = {};

exports.imsWeather = onCall(
  { region: "us-central1", secrets: [IMS_TOKEN], memory: "256MiB", timeoutSeconds: 30, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const pts = Array.isArray((request.data || {}).points) ? request.data.points.slice(0, 60) : [];
    const headers = { Authorization: "ApiToken " + String(IMS_TOKEN.value() || "").trim() };
    const get = async (path) => {
      const r = await fetch(IMS_BASE + path, { headers });
      if (!r.ok) { console.error("imsWeather", path, r.status, (await r.text()).slice(0, 300)); throw new HttpsError("unavailable", "IMS " + r.status); }
      return r.json();
    };
    if (!_imsStations || Date.now() - _imsStationsAt > 12 * 3600 * 1000) {
      const all = await get("/stations");
      _imsStations = (Array.isArray(all) ? all : []).filter((s) => s && s.active !== false && s.location &&
        isFinite(s.location.latitude) && isFinite(s.location.longitude));
      _imsStationsAt = Date.now();
    }
    const rad = (d) => d * Math.PI / 180;
    const km = (a, b, c, d) => {
      const x = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    };
    const out = {};
    for (const p of pts) {
      const lat = Number(p.lat), lon = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const pk = imsPick(_imsStations, lat, lon, "TD", p.station);
      if (!pk) continue;
      const best = pk.s, bd = pk.km;
      const sid = best.stationId;
      let latest = _imsLatest[sid];
      if (!latest || Date.now() - latest.at > 10 * 60 * 1000) {
        try {
          const j = await get("/stations/" + sid + "/data/latest");
          const row = (j && j.data && j.data[0]) || {};
          const ch = {};
          (row.channels || []).forEach((c) => { if (c && c.valid !== false) ch[c.name] = c.value; });
          latest = { at: Date.now(), dt: row.datetime ? imsTime(row.datetime).toISOString() : "", ch };
        } catch (e) { latest = { at: Date.now(), dt: "", ch: {} }; }
        _imsLatest[sid] = latest;
      }
      const ch = latest.ch;
      out[p.id] = {
        id: sid, name: String(best.name || ""), dist_km: Math.round(bd * 10) / 10, at: latest.dt,
        temp: ch.TD != null ? ch.TD : null, rh: ch.RH != null ? ch.RH : null,
        ws: ch.WS != null ? Math.round(ch.WS * 3.6 * 10) / 10 : null, wd: ch.WD != null ? ch.WD : null,
        rain: ch.Rain != null ? ch.Rain : null
      };
    }
    return { stations: out };
  }
);

// ═══════════════════════════════════════════
// SENTINEL-2 VEGETATION INDEX per plot (Oct 2026, satellite.js).
// Copernicus Data Space Ecosystem, Sentinel Hub Statistical API: for each
// plot polygon, the mean NDVI (vigour) and NDMI (canopy moisture) of every
// clear Sentinel-2 L2A pass, clouds / shadows / water / snow masked out by
// the scene classification (SCL). Free for commercial use.
// Needs an OAuth client from the CDSE dashboard (User settings → OAuth
// clients), kept as two secrets, never in the browser:
//   firebase functions:secrets:set CDSE_CLIENT_ID
//   firebase functions:secrets:set CDSE_CLIENT_SECRET
// Operator/admin only (each call spends the account's monthly quota); the
// browser caches the results in appData/shorashim-sentinel-<farmId> so
// workers read them without calling here.
// ═══════════════════════════════════════════
const CDSE_CLIENT_ID = defineSecret("CDSE_CLIENT_ID");
const CDSE_CLIENT_SECRET = defineSecret("CDSE_CLIENT_SECRET");
const CDSE_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const CDSE_STATS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics";
let _cdseTok = null, _cdseTokExp = 0;
const S2_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "B8A", "B11", "SCL", "dataMask"] }],
    output: [{ id: "ndvi", bands: 1 }, { id: "ndmi", bands: 1 }, { id: "dataMask", bands: 1 }]
  };
}
// SCL: 0 no data, 1 saturated, 3 cloud shadow, 6 water, 8/9 cloud, 10 cirrus, 11 snow
var BAD = [0, 1, 3, 6, 8, 9, 10, 11];
function evaluatePixel(s) {
  var d1 = s.B08 + s.B04, d2 = s.B8A + s.B11;
  var ok = s.dataMask === 1 && BAD.indexOf(s.SCL) < 0 && d1 > 0 && d2 > 0;
  return {
    ndvi: [ok ? (s.B08 - s.B04) / d1 : 0],
    ndmi: [ok ? (s.B8A - s.B11) / d2 : 0],
    dataMask: [ok ? 1 : 0]
  };
}`;

async function cdseToken() {
  if (_cdseTok && Date.now() < _cdseTokExp - 60000) return _cdseTok;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: String(CDSE_CLIENT_ID.value() || "").trim(),
    client_secret: String(CDSE_CLIENT_SECRET.value() || "").trim()
  });
  const r = await fetch(CDSE_TOKEN_URL, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!r.ok) throw new HttpsError("failed-precondition", "CDSE login " + r.status + " — check CDSE_CLIENT_ID / CDSE_CLIENT_SECRET");
  const j = await r.json();
  _cdseTok = j.access_token;
  _cdseTokExp = Date.now() + (Number(j.expires_in) || 300) * 1000;
  return _cdseTok;
}

exports.sentinelNdvi = onCall(
  { region: "us-central1", secrets: [CDSE_CLIENT_ID, CDSE_CLIENT_SECRET], memory: "256MiB", timeoutSeconds: 120, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    if ((tok.firebase || {}).sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (tok.role !== undefined && tok.role !== null && !["admin", "operator"].includes(tok.role)) {
      throw new HttpsError("permission-denied", "Operator or admin required");
    }
    const data = request.data || {};
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const to = day.test(data.to) ? data.to : new Date().toISOString().slice(0, 10);
    const from = day.test(data.from) ? data.from : new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    if (from >= to) throw new HttpsError("invalid-argument", "from must be before to");
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 800) throw new HttpsError("invalid-argument", "at most 800 days per call");
    const plots = (Array.isArray(data.plots) ? data.plots : []).slice(0, 30);
    // rings: [[[lon,lat],...], ...] — first ring the plot, others extra parts
    const geomOf = (p) => {
      const rings = (Array.isArray(p.rings) ? p.rings : []).map((r) => (Array.isArray(r) ? r : [])
        .map((c) => [Number(c[0]), Number(c[1])])
        .filter((c) => isFinite(c[0]) && isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90))
        .filter((r) => r.length >= 3)
        .slice(0, 20)
        .map((r) => {
          const c = r.slice(0, 500);
          const a = c[0], b = c[c.length - 1];
          if (a[0] !== b[0] || a[1] !== b[1]) c.push([a[0], a[1]]);
          return c;
        });
      if (!rings.length) return null;
      return rings.length === 1 ? { type: "Polygon", coordinates: [rings[0]] }
                                : { type: "MultiPolygon", coordinates: rings.map((r) => [r]) };
    };
    const access = await cdseToken();
    const one = async (p) => {
      const geometry = geomOf(p);
      if (!geometry) return [String(p.id), { err: "no polygon" }];
      const req = {
        input: {
          bounds: { geometry, properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
          data: [{ type: "sentinel-2-l2a", dataFilter: { maxCloudCoverage: 80 } }]
        },
        aggregation: {
          timeRange: { from: from + "T00:00:00Z", to: to + "T23:59:59Z" },
          aggregationInterval: { of: "P1D" },
          evalscript: S2_EVALSCRIPT,
          resx: 0.0001, resy: 0.0001
        }
      };
      const r = await fetch(CDSE_STATS_URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + access, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(req)
      });
      if (r.status === 429) return [String(p.id), { err: "quota" }];
      if (!r.ok) { console.error("sentinelNdvi CDSE", r.status, (await r.text()).slice(0, 400)); return [String(p.id), { err: "CDSE " + r.status }]; }
      const j = await r.json();
      const pts = [];
      (j.data || []).forEach((iv) => {
        const o = iv && iv.outputs;
        if (!o || !o.ndvi || iv.error) return;
        const sv = (o.ndvi.bands.B0 || {}).stats || {}, sm = ((o.ndmi || {}).bands || {}).B0 || {};
        const n = Number(sv.sampleCount) || 0, nd = Number(sv.noDataCount) || 0;
        if (!n || (n - nd) / n < 0.5 || !isFinite(Number(sv.mean))) return;
        pts.push({
          d: String(iv.interval.from).slice(0, 10),
          v: Math.round(Number(sv.mean) * 1000) / 1000,
          m: isFinite(Number((sm.stats || {}).mean)) ? Math.round(Number(sm.stats.mean) * 1000) / 1000 : null,
          c: Math.round((n - nd) / n * 100) / 100
        });
      });
      return [String(p.id), { pts }];
    };
    const out = {};
    // four at a time — gentle on the per-minute request limit
    for (let i = 0; i < plots.length; i += 4) {
      const res = await Promise.all(plots.slice(i, i + 4).map((p) => one(p).catch((e) => [String(p.id), { err: String(e.message || e).slice(0, 80) }])));
      res.forEach(([id, v]) => { out[id] = v; });
    }
    return { from, to, plots: out };
  }
);

// Sentinel-2 pixel image of a set of plot polygons on one date (satellite.js
// "pixel map"). Process API, clipped to the polygons, 10 m pixels. Returned
// as an RGBA PNG that carries values, not colours, so the browser can colour
// it either absolutely or relative to each plot without another call:
//   R = NDVI, G = NDMI   (each (v + 0.2) / 1.2 * 254)
//   B = 1 where the pixel is cloud / shadow / water that day
//   A = 255 inside the plots, 0 outside
const CDSE_PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process";
const S2_PX_EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: [{ bands: ["B04", "B08", "B8A", "B11", "SCL", "dataMask"] }],
           output: { bands: 4, sampleType: "UINT8" } };
}
var BAD = [0, 1, 3, 6, 8, 9, 10, 11];
function sc(v) { return Math.max(0, Math.min(254, Math.round((v + 0.2) / 1.2 * 254))); }
function evaluatePixel(s) {
  var d1 = s.B08 + s.B04, d2 = s.B8A + s.B11;
  if (s.dataMask !== 1 || d1 <= 0 || d2 <= 0) return [0, 0, 0, 0];
  return [sc((s.B08 - s.B04) / d1), sc((s.B8A - s.B11) / d2), BAD.indexOf(s.SCL) >= 0 ? 1 : 0, 255];
}`;

exports.sentinelImage = onCall(
  { region: "us-central1", secrets: [CDSE_CLIENT_ID, CDSE_CLIENT_SECRET], memory: "256MiB", timeoutSeconds: 60, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    if ((tok.firebase || {}).sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (tok.role !== undefined && tok.role !== null && !["admin", "operator"].includes(tok.role)) {
      throw new HttpsError("permission-denied", "Operator or admin required");
    }
    const data = request.data || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || "")) throw new HttpsError("invalid-argument", "date YYYY-MM-DD required");
    const rings = (Array.isArray(data.rings) ? data.rings : []).slice(0, 300).map((r) => (Array.isArray(r) ? r : [])
      .map((c) => [Number(c[0]), Number(c[1])])
      .filter((c) => isFinite(c[0]) && isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90)
      .slice(0, 500))
      .filter((r) => r.length >= 3)
      .map((r) => { const a = r[0], b = r[r.length - 1]; if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]); return r; });
    if (!rings.length) throw new HttpsError("invalid-argument", "no polygons");
    let w = 180, s = 90, e = -180, n = -90;
    rings.forEach((r) => r.forEach(([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }));
    const lat = (s + n) / 2;
    const mx = (e - w) * 111320 * Math.cos(lat * Math.PI / 180), my = (n - s) * 110574;
    if (mx > 25000 || my > 25000) throw new HttpsError("invalid-argument", "area too large");
    const width = Math.max(1, Math.min(2500, Math.round(mx / 10))), height = Math.max(1, Math.min(2500, Math.round(my / 10)));
    // The rectangle around the plots, not the plots themselves: a farm's
    // plots sent as one MultiPolygon are rejected when two overlap or a
    // boundary crosses itself (COMMON_BAD_PAYLOAD). The browser cuts the
    // plots out of the image (it already maps every pixel to its plot).
    const body = {
      input: {
        bounds: { bbox: [w, s, e, n], properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
        data: [{ type: "sentinel-2-l2a", dataFilter: {
          timeRange: { from: data.date + "T00:00:00Z", to: data.date + "T23:59:59Z" }, mosaickingOrder: "leastCC" } }]
      },
      output: { width, height, responses: [{ identifier: "default", format: { type: "image/png" } }] },
      evalscript: S2_PX_EVALSCRIPT
    };
    const access = await cdseToken();
    const r = await fetch(CDSE_PROCESS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + access, "Content-Type": "application/json", Accept: "image/png" },
      body: JSON.stringify(body)
    });
    if (r.status === 429) throw new HttpsError("resource-exhausted", "CDSE quota");
    if (!r.ok) {
      const errText = (await r.text()).slice(0, 600);
      console.error("sentinelImage CDSE", r.status, JSON.stringify({ width, height, rings: rings.length, date: data.date }), errText);
      throw new HttpsError("unavailable", "CDSE " + r.status + " " + errText.slice(0, 200));
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return { date: data.date, bbox: [w, s, e, n], width, height, png: buf.toString("base64") };
  }
);

// ═══════════════════════════════════════════
// TRAP COUNTS FROM A PHOTO / DOCUMENT (Oct 2026, traps.js)
// A photo of the field sheet, a PDF or a spreadsheet print-out of red palm
// weevil trap checks → date + one row per trap with its count, matched to
// the farm's own trap list. Worker+ (whoever checks the traps enters the
// counts); the person reviews every row before it is saved.
// ═══════════════════════════════════════════
const TRAPS_TOOL = {
  name: "report_trap_counts",
  description: "Report the trap checks found in the document.",
  input_schema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Check date YYYY-MM-DD if written (one date for the sheet); empty if none" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Trap name/number exactly as written" },
            zone: { type: "string", description: "Zone/area as written, if any" },
            count: { type: "number", description: "Number of weevils caught" },
            date: { type: "string", description: "Row date YYYY-MM-DD if rows have their own dates; else empty" },
            match_id: { type: "string", description: "id of the matching trap from the provided list, or empty if none matches" },
            confidence: { type: "string", enum: ["high", "medium", "low"] }
          },
          required: ["label", "count"]
        }
      },
      notes: { type: "string" }
    },
    required: ["rows"]
  }
};

exports.trapsExtract = onCall(
  { region: "us-central1", secrets: [ANTHROPIC_API_KEY], memory: "512MiB", timeoutSeconds: 180, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    if ((tok.firebase || {}).sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (!["admin", "operator", "worker"].includes(tok.role)) throw new HttpsError("permission-denied", "Worker or above required");
    const { image, pdf, traps, hint, year } = request.data || {};
    const b64ok = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 200));
    let block;
    if (pdf) {
      if (!b64ok(pdf, 9 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad or oversized PDF (max ~6.5 MB)");
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } };
    } else {
      if (!b64ok(image, 4 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad or oversized image");
      block = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } };
    }
    const list = (Array.isArray(traps) ? traps : []).slice(0, 600).map((t) => ({
      id: String(t && t.id || "").slice(0, 30), name: String(t && t.name || "").slice(0, 60), zone: String(t && t.zone || "").slice(0, 60)
    })).filter((t) => t.id && t.name);
    const ids = new Set(list.map((t) => t.id));
    const y = /^\d{4}$/.test(String(year || "")) ? String(year) : String(new Date().getFullYear());
    const userText = "This is a record of red palm weevil trap checks (Hebrew, Arabic, Thai or English; handwritten or printed). " +
      "Report every trap row with its count through the tool. Dates written as day/month belong to " + y + ". " +
      "Match each row to the farm's trap list below by name/number (and zone when it helps); leave match_id empty when unsure.\n" +
      "Trap list (id | name | zone):\n" + list.map((t) => t.id + " | " + t.name + " | " + t.zone).join("\n") +
      (typeof hint === "string" && hint.trim() ? "\nContext from the user: " + hint.trim().slice(0, 300) : "");
    const modelId = PLAN_MODELS["sonnet-5"];
    let res, text;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY.value(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: modelId, max_tokens: 8000,
          system: "You read agricultural pest-trap check sheets accurately. Never invent rows or counts; a count you cannot read is reported with confidence low.",
          tools: [TRAPS_TOOL], tool_choice: { type: "tool", name: "report_trap_counts" },
          messages: [{ role: "user", content: [block, { type: "text", text: userText }] }]
        })
      });
      text = await res.text();
    } catch (err) { throw new HttpsError("unavailable", "Model call failed: " + err.message); }
    if (!res.ok) throw new HttpsError("internal", modelId + " — " + res.status + ": " + text.slice(0, 200));
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new HttpsError("internal", "Bad model response"); }
    const call = (body.content || []).find((b) => b.type === "tool_use" && b.name === "report_trap_counts");
    if (!call || !call.input) throw new HttpsError("internal", "No rows returned");
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    const rows = (Array.isArray(call.input.rows) ? call.input.rows : []).slice(0, 600).map((r) => ({
      label: String(r.label || "").trim().slice(0, 60),
      zone: String(r.zone || "").trim().slice(0, 60),
      count: Math.max(0, Math.min(10000, Math.round(Number(r.count) || 0))),
      date: day(r.date),
      match_id: ids.has(String(r.match_id || "")) ? String(r.match_id) : "",
      confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low"
    })).filter((r) => r.label);
    return { date: day(call.input.date), rows, notes: String(call.input.notes || "").slice(0, 300), model: modelId };
  }
);

// ═══════════════════════════════════════════
// GROWING RECOMMENDATIONS FROM A PHOTO / PDF / LINK (Oct 2026, plotrec.js)
// An extension-service card or document (weekly irrigation by region,
// monthly crop coefficients, seasonal tasks) → structured rows the operator
// reviews before they are applied to a crop. A link is fetched here (https
// only, PDF or HTML, ≤ 8 MB) so the browser never needs CORS access.
// ═══════════════════════════════════════════
const REC_TOOL = {
  name: "report_recommendations",
  description: "Report the growing recommendations found in the document.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" }, publisher: { type: "string", description: "Who issued it (e.g. שה\"ם, מו\"פ, a company)" },
      crop: { type: "string", description: "Crop name in Hebrew" }, region: { type: "string", description: "The region row chosen (and soil type), per the user's context" },
      period: { type: "string", description: "Dates / week / season the recommendation covers" },
      months: {
        type: "array", description: "Irrigation per calendar month for the chosen region/soil. One entry per month covered.",
        items: { type: "object", properties: {
          month: { type: "integer", minimum: 1, maximum: 12 },
          value: { type: "number" },
          unit: { type: "string", enum: ["frac", "ltmm", "m3d"], description: "frac = coefficient × evaporation (per area); ltmm = litres per tree per mm of evaporation; m3d = fixed m³ per dunam per day" }
        }, required: ["month", "value", "unit"] }
      },
      irrigation_notes: { type: "string", description: "Frequency, soil adjustments, crop-to-crop ratios — short" },
      fert_notes: { type: "string", description: "Fertilization guidance — short, with numbers as written" },
      tasks: { type: "array", items: { type: "object", properties: {
        title: { type: "string" }, text: { type: "string" }, month: { type: "integer", minimum: 1, maximum: 12 }
      }, required: ["title"] } },
      notes: { type: "string" }
    },
    required: ["months", "tasks"]
  }
};

exports.recExtract = onCall(
  { region: "us-central1", secrets: [ANTHROPIC_API_KEY], memory: "512MiB", timeoutSeconds: 180, maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    if ((tok.firebase || {}).sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (!["admin", "operator"].includes(tok.role)) throw new HttpsError("permission-denied", "Operator or admin required");
    const { image, pdf, url, hint, crops } = request.data || {};
    const b64ok = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 200));
    let block;
    if (pdf) {
      if (!b64ok(pdf, 9 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad or oversized PDF (max ~6.5 MB)");
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } };
    } else if (image) {
      if (!b64ok(image, 4 * 1024 * 1024)) throw new HttpsError("invalid-argument", "Bad or oversized image");
      block = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } };
    } else if (typeof url === "string" && /^https:\/\/[^\s]+$/.test(url) && url.length < 1000) {
      let r;
      try { r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "ShorashimPlus/1.0" } }); }
      catch (e) { throw new HttpsError("unavailable", "Could not fetch the link"); }
      if (!r.ok) throw new HttpsError("unavailable", "Link returned " + r.status);
      const type = String(r.headers.get("content-type") || "");
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new HttpsError("invalid-argument", "Linked file too large");
      if (/pdf/i.test(type) || buf.slice(0, 4).toString() === "%PDF") {
        block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
      } else if (/image\/(jpeg|png|webp)/i.test(type)) {
        block = { type: "image", source: { type: "base64", media_type: type.match(/image\/(jpeg|png|webp)/i)[0].toLowerCase(), data: buf.toString("base64") } };
      } else {
        const text = buf.toString("utf8").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 60000);
        block = { type: "text", text: "Page content from " + url + ":\n" + text };
      }
    } else throw new HttpsError("invalid-argument", "image, pdf or https url required");
    const cropList = (Array.isArray(crops) ? crops : []).filter((c) => typeof c === "string").map((c) => c.slice(0, 40)).slice(0, 60);
    const userText = "Read these growing recommendations (usually Hebrew, from the Israeli extension service or a professional body) and report them through the tool. " +
      "Irrigation: when the document gives a table by region and soil, choose the row matching the user's context below and say which in `region`; convert to calendar months (a weekly card → the month it falls in). " +
      "Use unit m3d for fixed m³/dunam/day, ltmm for litres per tree per mm of evaporation, frac for a coefficient multiplied by evaporation. Never invent numbers; omit what is not written. " +
      "Tasks: concrete actions with their month. Keep text short." +
      (cropList.length ? " The farm's crops: " + cropList.join(", ") + "." : "") +
      (typeof hint === "string" && hint.trim() ? " User's context (region, soil): " + hint.trim().slice(0, 300) : "");
    const modelId = PLAN_MODELS["sonnet-5"];
    let res, text;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY.value(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: modelId, max_tokens: 6000,
          system: "You extract agronomic recommendations accurately for a farm-management app. Report only what the document states.",
          tools: [REC_TOOL], tool_choice: { type: "tool", name: "report_recommendations" },
          messages: [{ role: "user", content: [block, { type: "text", text: userText }] }]
        })
      });
      text = await res.text();
    } catch (err) { throw new HttpsError("unavailable", "Model call failed: " + err.message); }
    if (!res.ok) throw new HttpsError("internal", modelId + " — " + res.status + ": " + text.slice(0, 200));
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new HttpsError("internal", "Bad model response"); }
    const call = (body.content || []).find((b) => b.type === "tool_use" && b.name === "report_recommendations");
    if (!call || !call.input) throw new HttpsError("internal", "Nothing extracted");
    const s = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const inp = call.input;
    return {
      title: s(inp.title, 120), publisher: s(inp.publisher, 60), crop: s(inp.crop, 40), region: s(inp.region, 80), period: s(inp.period, 60),
      months: (Array.isArray(inp.months) ? inp.months : []).map((m) => ({
        month: Math.round(Number(m.month)), value: Math.round(Number(m.value) * 1000) / 1000, unit: ["frac", "ltmm", "m3d"].includes(m.unit) ? m.unit : "frac"
      })).filter((m) => m.month >= 1 && m.month <= 12 && isFinite(m.value) && m.value >= 0 && m.value < 1000).slice(0, 12),
      irrigation_notes: s(inp.irrigation_notes, 300), fert_notes: s(inp.fert_notes, 300),
      tasks: (Array.isArray(inp.tasks) ? inp.tasks : []).slice(0, 30).map((t) => ({
        title: s(t.title, 120), text: s(t.text, 300), month: Number.isInteger(t.month) && t.month >= 1 && t.month <= 12 ? t.month : null
      })).filter((t) => t.title),
      notes: s(inp.notes, 300), model: modelId
    };
  }
);

// ═══════════════════════════════════════════
// PLAN PDF — a treatment-plan document printed by a real Chrome
//   The app used to photograph the page in the browser and slice the
//   picture into A4 sheets: cut rows, odd page breaks, soft text. Chrome's
//   own print engine lays the pages out properly (rows never split, table
//   headers repeat, text stays sharp and selectable). The browser sends the
//   finished HTML; this returns the PDF. If this function is missing or
//   fails, the app falls back to its old in-browser method.
// ═══════════════════════════════════════════
const PDF_HOSTS = [
  "fonts.googleapis.com", "fonts.gstatic.com",               // Rubik / Heebo
  "server.arcgisonline.com", "services.arcgisonline.com",     // satellite map tiles
  "firebasestorage.googleapis.com", "storage.googleapis.com"  // label images
];
let _pdfBrowser = null;
async function pdfBrowser() {
  if (_pdfBrowser && _pdfBrowser.connected) return _pdfBrowser;
  const chromium = require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");
  _pdfBrowser = await puppeteer.launch({
    args: chromium.args, defaultViewport: { width: 1123, height: 794 },
    executablePath: await chromium.executablePath(), headless: chromium.headless
  });
  return _pdfBrowser;
}
exports.planPdf = onCall(
  { region: "us-central1", memory: "2GiB", cpu: 1, timeoutSeconds: 120, maxInstances: 3, concurrency: 1 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    const fb = tok.firebase || {};
    if (fb.sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (tok.role !== undefined && tok.role !== null && !["admin", "operator"].includes(tok.role)) {
      throw new HttpsError("permission-denied", "Operator or admin required");
    }
    const { html, landscape } = request.data || {};
    if (typeof html !== "string" || html.length < 50 || html.length > 8 * 1024 * 1024) {
      throw new HttpsError("invalid-argument", "html missing or too large");
    }
    const browser = await pdfBrowser();
    const page = await browser.newPage();
    try {
      // The document may load only fonts, map tiles and label images from
      // the hosts above (nothing internal); every request, scripted or not,
      // goes through this filter. Its one script fits each orchard sheet to
      // a page (see agriplan.js FIT_JS) and sets data-fit when done.
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        const u = r.url();
        if (u.startsWith("data:") || u.startsWith("about:")) return r.continue();
        let host = "";
        try { const x = new URL(u); host = x.protocol === "https:" ? x.hostname : ""; } catch (e) { host = ""; }
        if (host && PDF_HOSTS.includes(host)) return r.continue();
        return r.abort();
      });
      // Lay out at the printed width (A4 minus 14 mm margins) so the fit
      // script measures what will actually print.
      const land = landscape !== false;
      await page.emulateMediaType("print");
      await page.setViewport({ width: Math.round(((land ? 297 : 210) - 28) * 96 / 25.4), height: 800 });
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
      await page.evaluateHandle("document.fonts.ready");
      await page.waitForFunction("document.documentElement.dataset.fit === '1'", { timeout: 5000 }).catch(() => {});
      const pdf = await page.pdf({
        format: "A4", landscape: land, printBackground: true, preferCSSPageSize: true
      });
      return { pdf: Buffer.from(pdf).toString("base64") };
    } catch (err) {
      throw new HttpsError("internal", "PDF failed: " + (err && err.message ? err.message.slice(0, 200) : "unknown"));
    } finally {
      try { await page.close(); } catch (e) {}
    }
  }
);

// ═══════════════════════════════════════════
// FULL BACKUP — everything the app keeps, in one ZIP (admin only)
//   firestore/   every collection and sub-collection, one JSON file per
//                collection path: [{ id, data }] (timestamps as ISO text)
//   storage/     every uploaded file (labels, drawings, photos…)
//   auth-users.json  the sign-in accounts with their roles
//   manifest.json    when, by whom, counts
//   The ZIP is streamed into Storage (backups/, closed to the app by the
//   storage rules) and handed back as a one-off download link. The three
//   newest backups are kept, older ones deleted.
// ═══════════════════════════════════════════
exports.backupAll = onCall(
  { region: "us-central1", memory: "1GiB", timeoutSeconds: 540, maxInstances: 1, concurrency: 1 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const tok = request.auth.token || {};
    if ((tok.firebase || {}).sign_in_provider === "phone") throw new HttpsError("permission-denied", "Not for recovery sessions");
    if (tok.role !== "admin") throw new HttpsError("permission-denied", "Admin only");

    const archiver = require("archiver");
    const crypto = require("crypto");
    const fs = getFirestore();
    const bucket = getStorage().bucket("shorashim-plus.firebasestorage.app");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = "backups/shorashim-backup-" + stamp + ".zip";
    const token = crypto.randomUUID();
    const out = bucket.file(path).createWriteStream({
      resumable: false, contentType: "application/zip",
      metadata: { metadata: { firebaseStorageDownloadTokens: token } }
    });
    const zip = archiver("zip", { zlib: { level: 6 } });
    const done = new Promise((resolve, reject) => { out.on("finish", resolve); out.on("error", reject); zip.on("error", reject); });
    zip.pipe(out);

    // Firestore values → plain JSON (Timestamp → ISO, refs → path, bytes → base64)
    const plain = (v) => {
      if (v === null || typeof v !== "object") return v;
      if (typeof v.toDate === "function" && typeof v.seconds === "number") return { __ts: v.toDate().toISOString() };
      if (typeof v.latitude === "number" && typeof v.longitude === "number" && Object.keys(v).length <= 2) return { __geo: [v.latitude, v.longitude] };
      if (v.path && v.firestore) return { __ref: v.path };
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString("base64") };
      if (Array.isArray(v)) return v.map(plain);
      const o = {}; Object.keys(v).forEach((k) => { o[k] = plain(v[k]); }); return o;
    };
    const counts = { collections: 0, docs: 0, files: 0, fileBytes: 0, users: 0 };
    async function dumpCollection(col) {
      const snap = await col.get();
      counts.collections++; counts.docs += snap.size;
      zip.append(JSON.stringify(snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) })), null, 1), { name: "firestore/" + col.path + ".json" });
      for (const d of snap.docs) {
        const subs = await d.ref.listCollections();
        for (const s of subs) await dumpCollection(s);
      }
    }
    for (const c of await fs.listCollections()) await dumpCollection(c);

    // sign-in accounts (no passwords - Google sign-in)
    const users = [];
    let pageToken;
    do {
      const r = await getAuth().listUsers(1000, pageToken);
      r.users.forEach((u) => users.push({
        uid: u.uid, email: u.email || "", displayName: u.displayName || "", phoneNumber: u.phoneNumber || "",
        disabled: !!u.disabled, customClaims: u.customClaims || {}, providers: (u.providerData || []).map((p) => p.providerId),
        created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime
      }));
      pageToken = r.pageToken;
    } while (pageToken);
    counts.users = users.length;
    zip.append(JSON.stringify(users, null, 1), { name: "auth-users.json" });

    // uploaded files
    const [files] = await bucket.getFiles();
    for (const f of files) {
      if (f.name.startsWith("backups/") || f.name.endsWith("/")) continue;
      counts.files++; counts.fileBytes += Number(f.metadata.size) || 0;
      zip.append(f.createReadStream(), { name: "storage/" + f.name });
    }

    zip.append(JSON.stringify({ app: "shorashim-plus", created: new Date().toISOString(), by: tok.email || request.auth.uid, counts,
      note: "Code is in GitHub (alonovad/shorashim-plus). Firestore: firestore/<collection path>.json; Storage: storage/<path>." }, null, 1), { name: "manifest.json" });
    await zip.finalize();
    await done;

    // keep the three newest backups
    try {
      const [old] = await bucket.getFiles({ prefix: "backups/" });
      old.sort((a, b) => String(b.name).localeCompare(String(a.name))).slice(3).forEach((f) => f.delete().catch(() => {}));
    } catch (e) { /* retention is best-effort */ }

    const [meta] = await bucket.file(path).getMetadata();
    const url = "https://firebasestorage.googleapis.com/v0/b/" + bucket.name + "/o/" + encodeURIComponent(path) + "?alt=media&token=" + token;
    return { url, name: path.split("/").pop(), bytes: Number(meta.size) || 0, counts };
  }
);

// ═══════════════════════════════════════════
// IMS DATA — history and point-in-time readings from the nearest IMS
// stations (Oct 2026). One callable, two modes:
//   mode "days": { points:[{id,lat,lon}], from, to } → per point, per day:
//       rain (mm), Tmax/Tmin/Tmean (°C), RH, wind mean/max (km/h),
//       radiation (MJ/m²), ET0 (mm, FAO-56 Penman-Monteith from the
//       station's radiation; Hargreaves when it has none) - each element
//       from the nearest station that measures it
//   mode "at":   { lat, lon, at } → the reading closest to that time
// Daily figures are cached in Firestore (imsDaily/{station}_{yyyy-mm}),
// closed months for good, the current month for 3 hours. The app never
// reads that collection directly (rules deny it); only this function does.
// ═══════════════════════════════════════════
const IMS_ELEMENTS = { temp: "TD", rain: "Rain", rad: "Grad", wind: "WS" };
const IMS_CACHE_V = 2;          // bump when the daily summary changes, so cached months are rebuilt
const IMS_MAX_KM = { temp: 30, rain: 25, rad: 25, wind: 30 };   // beyond this a station does not stand for the farm
// IMS stamps every observation in Israel WINTER time (UTC+2) whatever offset
// the text carries (API documentation); read it that way, return true UTC.
function imsTime(dt) { const m = String(dt || "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/); return m ? new Date(m[1] + "+02:00") : null; }
async function imsGet(path) {
  const r = await fetch(IMS_BASE + path, { headers: { Authorization: "ApiToken " + String(IMS_TOKEN.value() || "").trim() } });
  if (!r.ok) { console.error("ims", path, r.status, (await r.text()).slice(0, 200)); throw new HttpsError("unavailable", "IMS " + r.status); }
  return r.json();
}
async function imsStationList() {
  if (!_imsStations || Date.now() - _imsStationsAt > 12 * 3600 * 1000) {
    const all = await imsGet("/stations");
    _imsStations = (Array.isArray(all) ? all : []).filter((s) => s && s.active !== false && s.location &&
      isFinite(s.location.latitude) && isFinite(s.location.longitude));
    _imsStationsAt = Date.now();
  }
  return _imsStations;
}
function imsKm(a, b, c, d) {
  const rad = (x) => x * Math.PI / 180;
  const x = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function imsHas(s, ch) { return (s.monitors || []).some((m) => m && m.name === ch && m.active !== false); }
// nearest station measuring channel ch (any station when the list has no monitor info)
// a farm's chosen station (farm.ims_station) wins for every element it measures
function imsPick(list, lat, lon, ch, sid) {
  if (sid != null && sid !== "") {
    const s = list.find((x) => String(x.stationId) === String(sid));
    if (s && (!ch || imsHas(s, ch) || !(s.monitors || []).length)) return { s, km: Math.round(imsKm(lat, lon, Number(s.location.latitude), Number(s.location.longitude)) * 10) / 10, chosen: true };
  }
  return imsNearest(list, lat, lon, ch);
}
function imsNearest(list, lat, lon, ch) {
  let best = null, bd = Infinity;
  const anyInfo = list.some((s) => Array.isArray(s.monitors) && s.monitors.length);
  for (const s of list) {
    if (anyInfo && ch && !imsHas(s, ch)) continue;
    const d = imsKm(lat, lon, Number(s.location.latitude), Number(s.location.longitude));
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { s: best, km: Math.round(bd * 10) / 10 } : null;
}
const ymd = (d) => d.toISOString().slice(0, 10);
// FAO-56 daily reference evapotranspiration (mm)
function et0Daily(dy, lat, z) {
  if (dy.tmax == null || dy.tmin == null) return null;
  const doy = Math.floor((Date.UTC(+dy.d.slice(0, 4), +dy.d.slice(5, 7) - 1, +dy.d.slice(8, 10)) - Date.UTC(+dy.d.slice(0, 4), 0, 0)) / 864e5);
  const phi = lat * Math.PI / 180, dr = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365), dec = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
  const Ra = 24 * 60 / Math.PI * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
  const T = (dy.tmax + dy.tmin) / 2;
  if (dy.rs == null || dy.rhmax == null || dy.ws == null) {
    return { v: Math.max(0, 0.0023 * (T + 17.8) * Math.sqrt(Math.max(0, dy.tmax - dy.tmin)) * Ra * 0.408), m: "hg" };
  }
  const e0 = (t) => 0.6108 * Math.exp(17.27 * t / (t + 237.3));
  const D = 4098 * e0(T) / ((T + 237.3) ** 2), P = 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26, g = 0.000665 * P;
  const es = (e0(dy.tmax) + e0(dy.tmin)) / 2, ea = (e0(dy.tmin) * dy.rhmax / 100 + e0(dy.tmax) * dy.rhmin / 100) / 2;
  const u2 = (dy.ws / 3.6) * 4.87 / Math.log(67.8 * 10 - 5.42);
  const Rso = (0.75 + 2e-5 * z) * Ra, Rs = Math.min(dy.rs, Rso || dy.rs);
  const Rnl = 4.903e-9 * (((dy.tmax + 273.16) ** 4 + (dy.tmin + 273.16) ** 4) / 2) * (0.34 - 0.14 * Math.sqrt(Math.max(0, ea))) * (1.35 * (Rso ? Rs / Rso : 1) - 0.35);
  const Rn = 0.77 * Rs - Rnl;
  const v = (0.408 * D * Rn + g * 900 / (T + 273) * u2 * (es - ea)) / (D + g * (1 + 0.34 * u2));
  return { v: Math.max(0, v), m: "pm" };
}
// 10-minute records → one summary per local day
function imsAggregate(rows) {
  const by = {};
  for (const row of rows || []) {
    const d = String(row.datetime || "").slice(0, 10);
    if (!d) continue;
    const ch = {};
    (row.channels || []).forEach((c) => { if (c && c.valid !== false && isFinite(c.value)) ch[c.name] = Number(c.value); });
    const a = by[d] || (by[d] = { n: 0, t: [], rh: [], ws: [], wsmax: null, rain: 0, rainN: 0, g: [] });
    a.n++;
    if (ch.TD != null) a.t.push(ch.TD);
    if (ch.RH != null) a.rh.push(ch.RH);
    if (ch.WS != null) a.ws.push(ch.WS);
    if (ch.WSmax != null) a.wsmax = Math.max(a.wsmax == null ? -1 : a.wsmax, ch.WSmax);
    if (ch.Rain != null) { a.rain += ch.Rain; a.rainN++; }
    if (ch.Grad != null) a.g.push(Math.max(0, ch.Grad));
  }
  const out = {};
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const r1 = (x) => Math.round(x * 10) / 10;
  Object.keys(by).forEach((d) => {
    const a = by[d], o = { d, n: a.n };
    if (a.t.length >= 72) { o.tmax = r1(Math.max(...a.t)); o.tmin = r1(Math.min(...a.t)); o.tmean = r1(mean(a.t)); }
    if (a.rh.length >= 72) { o.rh = Math.round(mean(a.rh)); o.rhmax = Math.max(...a.rh); o.rhmin = Math.min(...a.rh); }
    if (a.ws.length >= 72) o.ws = r1(mean(a.ws) * 3.6);
    if (a.wsmax != null) o.wsmax = r1(a.wsmax * 3.6);
    if (a.rainN >= 72) o.rain = r1(a.rain);
    // night readings are often missing or flagged; count them as 0 and sum
    // the 10-minute energy (W/m² × 600 s) when daylight is covered
    if (a.g.length >= 60) o.rs = Math.round(a.g.reduce((s2, v) => s2 + v, 0) * 600 / 1e6 * 100) / 100;
    out[d] = o;
  });
  return out;
}
// one station-month of daily summaries, from the cache or from IMS
// Only the channels the summaries use, each its own request, all at once:
// one all-channel month from a station takes IMS ~40 s; six single-channel
// requests in parallel come back in a fraction of that.
const IMS_NEED = ["TD", "RH", "WS", "WSmax", "Rain", "Grad"];
async function imsFetchRange(st, from, to) {
  const sid = st.stationId, mons = (st.monitors || []).filter((m) => m && m.active !== false && IMS_NEED.includes(m.name) && m.channelId != null);
  if (!mons.length) { const j = await imsGet("/stations/" + sid + "/data?from=" + from + "&to=" + to); return (j && j.data) || []; }
  const parts = await Promise.all(mons.map((m) => imsGet("/stations/" + sid + "/data/" + m.channelId + "?from=" + from + "&to=" + to).catch((e) => { console.error("ims ch", sid, m.name, e.message); return null; })));
  const by = {};
  parts.forEach((j) => ((j && j.data) || []).forEach((row) => {
    const r = by[row.datetime] || (by[row.datetime] = { datetime: row.datetime, channels: [] });
    (row.channels || []).forEach((c) => r.channels.push(c));
  }));
  return Object.keys(by).sort().map((k) => by[k]);
}
async function imsMonth(sid, ym, st) {
  const db = getFirestore(), ref = db.collection("imsDaily").doc(sid + "_" + ym);
  const now = new Date(), curYm = now.toISOString().slice(0, 7);
  const snap = await ref.get();
  if (snap.exists) {
    const c = snap.data();
    if ((c.v || 1) >= IMS_CACHE_V && (c.closed || (ym === curYm && Date.now() - (c.at || 0) < 3 * 3600 * 1000))) return c.days || {};
  }
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = ym === curYm ? now.getUTCDate() : last;
  const rows = await imsFetchRange(st || { stationId: sid }, ym.replace("-", "/") + "/01", ym.replace("-", "/") + "/" + String(to).padStart(2, "0"));
  const days = imsAggregate(rows);
  if (ym === curYm) delete days[ymd(now)];          // today is not a whole day yet
  await ref.set({ days, at: Date.now(), closed: ym < curYm, v: IMS_CACHE_V });
  return days;
}
exports.imsData = onCall(
  { region: "us-central1", secrets: [IMS_TOKEN], memory: "1GiB", timeoutSeconds: 300, maxInstances: 5 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
    const q = request.data || {}, list = await imsStationList();
    // mode "stations": the stations around a point and what each measures -
    // so the choice of station can be checked, not taken on trust
    if (q.mode === "stations") {
      const lat = Number(q.lat), lon = Number(q.lon);
      if (!isFinite(lat) || !isFinite(lon)) throw new HttpsError("invalid-argument", "lat, lon");
      return { stations: list.filter((st) => !/_1m$/i.test(String(st.name || ""))).map((st) => ({ id: st.stationId, name: String(st.name || ""), km: Math.round(imsKm(lat, lon, Number(st.location.latitude), Number(st.location.longitude)) * 10) / 10,
        alt: st.location.altitude != null ? st.location.altitude : (st.altitude != null ? st.altitude : null),
        channels: (st.monitors || []).filter((m) => m && m.active !== false).map((m) => m.name) }))
        .filter((x) => x.km <= (Number(q.km) || 60)).sort((a, b) => a.km - b.km) };
    }
    if (q.mode === "at") {
      const lat = Number(q.lat), lon = Number(q.lon), at = new Date(q.at || Date.now());
      if (!isFinite(lat) || !isFinite(lon) || isNaN(at)) throw new HttpsError("invalid-argument", "lat, lon, at");
      const n = imsPick(list, lat, lon, "TD", q.station);
      if (!n) return { none: true };
      // the day before to the day after (UTC dates), so the local day is covered in any season
      const d0 = new Date(at.getTime() - 864e5).toISOString().slice(0, 10).replace(/-/g, "/"), d1 = new Date(at.getTime() + 864e5).toISOString().slice(0, 10).replace(/-/g, "/");
      const j = await imsGet("/stations/" + n.s.stationId + "/data?from=" + d0 + "&to=" + d1);
      let best = null, bd = Infinity;
      for (const row of (j && j.data) || []) { const tm = imsTime(row.datetime); if (!tm) continue; const dt = Math.abs(tm - at); if (dt < bd) { bd = dt; best = row; } }
      if (!best || bd > 90 * 60 * 1000) return { none: true, station: String(n.s.name || ""), dist_km: n.km };
      const ch = {}; (best.channels || []).forEach((c) => { if (c && c.valid !== false) ch[c.name] = c.value; });
      const k = (v) => v == null ? null : Math.round(v * 3.6 * 10) / 10;
      return { station: String(n.s.name || ""), id: n.s.stationId, dist_km: n.km, at: imsTime(best.datetime).toISOString(),
        temp: ch.TD != null ? ch.TD : null, rh: ch.RH != null ? ch.RH : null, ws: k(ch.WS), wsmax: k(ch.WSmax), wd: ch.WD != null ? ch.WD : null, rain: ch.Rain != null ? ch.Rain : null };
    }
    // mode "days"
    const pts = Array.isArray(q.points) ? q.points.slice(0, 30) : [];
    const from = new Date(String(q.from || "") + "T00:00:00Z"), to = new Date(String(q.to || "") + "T00:00:00Z");
    if (isNaN(from) || isNaN(to) || to < from || (to - from) / 864e5 > 400) throw new HttpsError("invalid-argument", "from / to (max 400 days)");
    const months = [];
    for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
    const cache = {};
    // a station's months, four at a time
    const stationDays = (stn) => {
      const sid = stn.stationId;
      if (!cache[sid]) cache[sid] = (async () => {
        const acc = {}, queue = months.slice();
        const worker = async () => { while (queue.length) { const ym = queue.shift(); try { Object.assign(acc, await imsMonth(sid, ym, stn)); } catch (e) { console.error("imsMonth", sid, ym, e.message); } } };
        await Promise.all([worker(), worker(), worker(), worker()]);
        return acc;
      })();
      return cache[sid];
    };
    const out = {};
    for (const p of pts) {
      const lat = Number(p.lat), lon = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const st = {};
      for (const k of Object.keys(IMS_ELEMENTS)) { const n = imsPick(list, lat, lon, IMS_ELEMENTS[k], p.station); st[k] = n && (n.chosen || n.km <= IMS_MAX_KM[k]) ? n : null; }
      if (!st.temp) continue;
      const src = {}, keys = Object.keys(st).filter((k) => st[k]);
      const got = await Promise.all(keys.map((k) => stationDays(st[k].s)));
      keys.forEach((k, i) => { src[k] = got[i]; });
      const z = Number((st.temp.s.location || {}).altitude) || 0;
      const days = [];
      for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        const k = ymd(d), t = (src.temp || {})[k] || {}, r = (src.rain || {})[k] || {}, g = (src.rad || {})[k] || {}, w = (src.wind || {})[k] || {};
        const dy = { d: k, tmax: t.tmax, tmin: t.tmin, tmean: t.tmean, rh: t.rh, rhmax: t.rhmax, rhmin: t.rhmin,
          ws: w.ws != null ? w.ws : t.ws, wsmax: w.wsmax != null ? w.wsmax : t.wsmax, rain: r.rain, rs: g.rs };
        const e = et0Daily(dy, lat, z);
        days.push({ d: k, tmax: dy.tmax, tmin: dy.tmin, tmean: dy.tmean, rh: dy.rh, ws: dy.ws, wsmax: dy.wsmax, rain: dy.rain, rs: dy.rs,
          et0: e ? Math.round(e.v * 10) / 10 : null, et0m: e ? e.m : null });
      }
      const nm = (x) => x ? { name: String(x.s.name || ""), km: x.km, id: x.s.stationId, chosen: !!x.chosen } : null;
      out[p.id] = { stations: { temp: nm(st.temp), rain: nm(st.rain), rad: nm(st.rad), wind: nm(st.wind) }, days };
    }
    return { points: out };
  }
);

// ═══════════════════════════════════════════
// WEATHER ALERTS — every 30 minutes, the latest reading of the IMS station
// nearest each farm: heat (≥ 40°), frost (≤ 2°), strong wind (≥ 30 km/h, or
// gusts ≥ 45), rain falling. Written to appData/shorashim-wx-alerts, which
// the home screen and the weather tab show; an alert keeps the time it
// started while it lasts.
// ═══════════════════════════════════════════
const { onSchedule } = require("firebase-functions/v2/scheduler");
exports.wxAlerts = onSchedule(
  { region: "us-central1", schedule: "every 30 minutes", timeZone: "Asia/Jerusalem", secrets: [IMS_TOKEN], memory: "256MiB", timeoutSeconds: 120 },
  async () => {
    const db = getFirestore();
    const pd = await db.collection("appData").doc("plotMapperSprayData").get();
    const v = (pd.exists && pd.data().value) || {};
    const plots = Array.isArray(v.plots) ? v.plots : [], farms = Array.isArray(v.farms) ? v.farms : [];
    const prevSnap = await db.collection("appData").doc("shorashim-wx-alerts").get();
    const prev = (prevSnap.exists && prevSnap.data().value && prevSnap.data().value.farms) || {};
    const list = await imsStationList();
    const latest = {};
    const out = {};
    for (const f of farms) {
      // the farm's largest plot stands for its location
      let best = null;
      for (const p of plots) {
        if (p.farm_id !== f.id || !Array.isArray(p.latlngs) || !p.latlngs.length) continue;
        if (!best || (Number(p.area) || 0) > (Number(best.area) || 0)) best = p;
      }
      if (!best) continue;
      const ll = best.latlngs.map((c) => [Number(c.lat !== undefined ? c.lat : c[0]), Number(c.lng !== undefined ? c.lng : c[1])]).filter((c) => isFinite(c[0]) && isFinite(c[1]));
      if (!ll.length) continue;
      const lat = ll.reduce((s, c) => s + c[0], 0) / ll.length, lon = ll.reduce((s, c) => s + c[1], 0) / ll.length;
      const n = imsPick(list, lat, lon, "TD", f.ims_station);
      if (!n) continue;
      const sid = n.s.stationId;
      if (!latest[sid]) {
        try {
          const j = await imsGet("/stations/" + sid + "/data/latest");
          const row = (j && j.data && j.data[0]) || {}, ch = {};
          (row.channels || []).forEach((c) => { if (c && c.valid !== false) ch[c.name] = c.value; });
          latest[sid] = { dt: row.datetime ? imsTime(row.datetime).toISOString() : "", ch };
        } catch (e) { latest[sid] = { dt: "", ch: {} }; }
      }
      const ch = latest[sid].ch, items = [];
      const ws = ch.WS != null ? ch.WS * 3.6 : null, gust = ch.WSmax != null ? ch.WSmax * 3.6 : null;
      if (ch.TD != null && ch.TD >= 40) items.push({ k: "heat", val: Math.round(ch.TD) });
      if (ch.TD != null && ch.TD <= 2) items.push({ k: "frost", val: Math.round(ch.TD * 10) / 10 });
      if ((ws != null && ws >= 30) || (gust != null && gust >= 45)) items.push({ k: "wind", val: Math.round(ws || 0), gust: gust != null ? Math.round(gust) : null });
      if (ch.Rain != null && ch.Rain > 0) items.push({ k: "rain", val: Math.round(ch.Rain * 10) / 10 });
      if (!items.length) continue;
      const was = ((prev[f.id] || {}).items) || [];
      items.forEach((it) => { const o = was.find((x) => x.k === it.k); it.since = o && o.since ? o.since : Date.now(); });
      out[f.id] = { station: String(n.s.name || ""), km: n.km, at: latest[sid].dt, items };
    }
    await db.collection("appData").doc("shorashim-wx-alerts").set({ value: { at: Date.now(), farms: out }, updatedAt: new Date() });
  }
);
