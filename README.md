# ovb-email-backend

Backend Node.js pentru sincronizarea emailurilor OVB (Outlook) în Firestore și gestionarea articolelor.

## Endpoint-uri
- `GET /` - Health check.
- `GET /sync-emails` - Sincronizează mesaje din mailbox-ul `TARGET_USER_EMAIL` în Firestore (colecția `emails`).
- `POST /articles` cu JSON `{ title, content }` - Adaugă un articol nou în Firestore (colecția `articles`).
- `POST /cleanup-articles` - Șterge articolele din Firestore mai vechi de 60 de zile (opțional, pentru Cloud Scheduler).

## Variabile de Mediu (Env vars)
CLIENT_ID, CLIENT_SECRET, TENANT_ID, TARGET_USER_EMAIL
