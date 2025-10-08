// index.js
import express from "express";
import fetch from "node-fetch";
import admin from "firebase-admin";

const app = express();
const port = process.env.PORT || 8080;

// Firestore init: On Cloud Run (same GCP project) this will use VM service account
admin.initializeApp();
const db = admin.firestore();

/*
 Required env vars (set in Cloud Run):
 - CLIENT_ID
 - CLIENT_SECRET
 - TENANT_ID
 - TARGET_USER_EMAIL   (ex: vasile.ivanciuc@ovbro.ro)
*/
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TENANT_ID = process.env.TENANT_ID;
const TARGET_USER_EMAIL = process.env.TARGET_USER_EMAIL;

let accessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // reuse token if still valid
  if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;

  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: "https://graph.microsoft.com/.default",
        client_secret: CLIENT_SECRET,
        grant_type: "client_credentials"
      })
    }
  );

  const data = await resp.json();
  if (!data.access_token) throw new Error("Nu s-a obținut token: " + JSON.stringify(data));
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return accessToken;
}

// Endpoint: sincronizeaza emailuri Outlook -> Firestore
app.get("/sync-emails", async (req, res) => {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID || !TARGET_USER_EMAIL) {
      return res.status(400).send("Lipsește o variabilă de mediu (CLIENT_ID/CLIENT_SECRET/TENANT_ID/TARGET_USER_EMAIL).");
    }

    const token = await getAccessToken();

    // folosim endpointul cu /users/{userPrincipalName}/messages (requires Application permission Mail.Read)
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(TARGET_USER_EMAIL)}/messages?$top=50&$select=id,subject,from,receivedDateTime,bodyPreview`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();

    if (resp.status >= 400) {
      console.error("Graph error:", data);
      return res.status(500).send("Eroare la apel Graph API: " + JSON.stringify(data));
    }

    const messages = data.value || [];
    for (const mail of messages) {
      await db.collection("emails").doc(mail.id).set({
        subject: mail.subject || null,
        from: mail.from?.emailAddress?.address || null,
        receivedDate: mail.receivedDateTime || null,
        preview: mail.bodyPreview || null,
        syncedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    res.status(200).send(`Am salvat ${messages.length} emailuri.`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Eroare internă: " + (err.message || err));
  }
});

// Endpoint pentru adăugarea unui articol (din front-end)
app.post("/articles", express.json(), async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).send("title și content sunt necesare.");

    const doc = await db.collection("articles").add({
      title,
      content,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).send({ id: doc.id });
  } catch (err) {
    console.error(err);
    res.status(500).send("Eroare la salvare articol.");
  }
});

// Endpoint health-check
app.get("/", (req, res) => res.send("Analize OVB backend funcționează ✅"));

// OPTIONAL: endpoint manual pentru declanșarea delete-ului (poate fi folosit și intern)
app.post("/cleanup-articles", async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 zile
    const q = db.collection("articles").where("createdAt", "<", cutoff);
    const snap = await q.get();
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.send(`Șterse ${snap.size} articole.`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Eroare la cleanup: " + err.message);
  }
});

app.listen(port, () => console.log(`Server listening on port ${port}`));
