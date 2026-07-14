const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();

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
