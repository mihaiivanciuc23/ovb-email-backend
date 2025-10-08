// index.js (Versiunea Hibrida: Articole din API + Pregatire OVB Email Sync)
import express from "express";
import fetch from "node-fetch";
import admin from "firebase-admin";

const app = express();
const port = process.env.PORT || 8080;

// Initialize Firestore (foloseste Service Account din Cloud Run)
admin.initializeApp();
const db = admin.firestore();

// -----------------------------------------------------
// 🔑 VARIABILE DE MEDIU NECESARE
// -----------------------------------------------------
// Pentru Sincronizarea Stirilor
const NEWS_API_KEY = process.env.NEWS_API_KEY;

// Pentru Sincronizarea Emailurilor (viitor, cand primesti cheile de la OVB)
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TENANT_ID = process.env.TENANT_ID;
const TARGET_USER_EMAIL = process.env.TARGET_USER_EMAIL;

let accessToken = null;
let tokenExpiresAt = 0; // Pentru a pastra tokenul Outlook valid

// -----------------------------------------------------
// 🔹 Functii Utilitare OVB (Pregatește-te pentru viitor)
// -----------------------------------------------------

// Functie pentru obtinerea Tokenului Microsoft Graph (utilizata pentru email-uri)
async function getAccessToken() {
    if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID) return null;
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
    if (!data.access_token) throw new Error("Nu s-a obținut token Outlook: " + JSON.stringify(data));
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return accessToken;
}

// 🔹 Endpoint pentru sincronizarea emailurilor Outlook -> Firestore (viitor)
app.get("/sync-emails", async (req, res) => {
    try {
        if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID || !TARGET_USER_EMAIL) {
            return res.status(400).send("Lipsește o variabilă de mediu OVB (CLIENT_ID/SECRET) pentru Outlook. Funcționalitate dezactivată.");
        }

        const token = await getAccessToken();
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(TARGET_USER_EMAIL)}/messages?$top=50&$select=id,subject,from,receivedDateTime,bodyPreview`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const data = await resp.json();

        if (resp.status >= 400) {
            return res.status(500).send("Eroare la apel Graph API: " + JSON.stringify(data));
        }

        const messages = data.value || [];
        for (const mail of messages) {
            await db.collection("emails").doc(mail.id).set({
                subject: mail.subject,
                from: mail.from?.emailAddress?.address,
                receivedDate: mail.receivedDateTime,
                preview: mail.bodyPreview,
                syncedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        res.status(200).send(`Am salvat ${messages.length} emailuri din Outlook.`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Eroare interna OVB Email Sync: " + (err.message || err));
    }
});


// -----------------------------------------------------
// 📰 Functii pentru Stirile Publice (Focusul Actual)
// -----------------------------------------------------

// Functie utilitara pentru sincronizarea stirilor
async function fetchAndSaveArticles(query, language = 'ro') {
    if (!NEWS_API_KEY) {
        throw new Error("Variabila de mediu NEWS_API_KEY lipseste. Sincronizarea stirilor este dezactivata.");
    }

    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=${language}&apiKey=${NEWS_API_KEY}`;
    
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== 'ok') {
        throw new Error("Eroare la apel News API: " + data.message);
    }

    const articles = data.articles || [];
    let savedCount = 0;

    for (const article of articles) {
        // Folosim URL-ul ca ID unic.
        const docId = Buffer.from(article.url).toString('base64').replace(/=/g, ''); 

        await db.collection("articles").doc(docId).set({
            source: article.source?.name || 'Unknown',
            title: article.title || null,
            url: article.url || null,
            description: article.description || null,
            publishedAt: article.publishedAt,
            language: language,
            query_tag: query, 
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        savedCount++;
    }
    return savedCount;
}

// 🔹 Endpoint principal pentru SINCRONIZAREA ARTICOLElor
// Exemplu: GET /sync-articles?q=BNR+prognoza&lang=ro
app.get("/sync-articles", async (req, res) => {
    try {
        const query = req.query.q;
        const lang = req.query.lang || 'ro'; 

        if (!query) {
            return res.status(400).send("Parametrul 'q' (query) lipseste.");
        }

        const count = await fetchAndSaveArticles(query, lang);

        res.status(200).send(`Sincronizare pentru '${query}' (${lang}) completa. Am salvat ${count} articole.`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Eroare interna la sincronizarea articolelor: " + (err.message || err));
    }
});

// 🔹 Endpoint pentru curatarea (cleanup) articolelor vechi (dupa 60 de zile)
app.post("/cleanup-articles", async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); 
    const q = db.collection("articles").where("createdAt", "<", cutoff);
    const snap = await q.get();
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.send(`Șterse ${snap.size} articole mai vechi de 60 de zile.`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Eroare la cleanup: " + err.message);
  }
});


// 🔹 Endpoint health-check
app.get("/", (req, res) => res.send("Analize OVB backend funcționează ✅"));

app.listen(port, () => console.log(`Server listening on port ${port}`));
