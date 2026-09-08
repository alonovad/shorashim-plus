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

const PLAN_MODELS = {
  haiku:  "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5"
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
          required: ["kind", "name", "count", "w", "h", "rebar", "confidence"]
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
  "Never invent a value: if a number is not on the document, omit the field and lower the confidence.",
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

    const { path, model, hint } = request.data || {};
    if (typeof path !== "string" || !/^build-plans\/\d+\/[^/]+$/.test(path)) {
      throw new HttpsError("invalid-argument", "path must be build-plans/{projectId}/{file}");
    }
    const modelId = PLAN_MODELS[model] || PLAN_MODELS.haiku;

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

    const [buf] = await file.download();
    const data = buf.toString("base64");
    const block = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: ctype, data } };

    const userText = "Read this construction document and report it through the tool." +
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
          max_tokens: 8000,
          system: PLAN_SYSTEM,
          tools: [PLAN_TOOL],
          tool_choice: { type: "tool", name: "report_plan" },
          messages: [{ role: "user", content: [block, { type: "text", text: userText }] }]
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
