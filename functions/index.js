const { onRequest } = require("firebase-functions/v2/https");

exports.talgilProxy = onRequest(
  { region: "us-central1", maxInstances: 5 },
  async (req, res) => {
    // CORS — only needed for direct function calls (hosting rewrite skips CORS entirely)
    res.set("Access-Control-Allow-Origin", "https://shorashim-plus.web.app");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    const { host, controllerId, user, pass, apiKey, endpoint, filter } = req.body || {};
    if (!host || !controllerId || !endpoint) {
      res.status(400).json({ error: "Missing host, controllerId, or endpoint" });
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
