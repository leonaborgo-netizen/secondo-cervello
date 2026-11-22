# 🧠 Secondo Cervello

Assistente personale e memoria intelligente: backend **Node.js + Express + SQLite**, frontend **PWA** senza build.
Le chiamate IA (coach, parsing, brief, Whisper) avvengono **solo sul server**: nel browser non c'è nessuna chiave.

## Uso locale
Requisiti: Node.js 20+.
```bash
npm install
cp .env.example .env     # imposta AI_PROVIDER e la chiave
npm start                # http://localhost:3000
```

## Deploy su cloud (un solo servizio: backend + frontend)
Il backend serve anche il frontend, quindi l'app usa **automaticamente l'URL pubblico su cui è ospitata** (`apiBase` vuoto = stesso dominio): nessun indirizzo da riscrivere, funziona da qualsiasi rete e dal telefono (HTTPS fornito dalla piattaforma → microfono e installazione PWA funzionano).

Prima di tutto metti il progetto su un repository GitHub (`.env` e `data/` sono già esclusi da `.gitignore`).

### Render
1. Dashboard → **New → Blueprint** → scegli il repository: legge `render.yaml` (servizio web + disco da 1 GB su `/var/data`).
2. Inserisci i segreti richiesti: `APP_PASSWORD`, `ANTHROPIC_API_KEY` (e `OPENAI_API_KEY` se vuoi Whisper).
3. Al termine apri l'URL `https://<nome>.onrender.com` e accedi con la password.
> Il disco persistente richiede un piano a pagamento. Senza disco il database si azzera a ogni deploy/riavvio.

### Railway
1. **New Project → Deploy from GitHub repo**.
2. Nel servizio: **Settings → Volumes → New Volume**, mount path `/data`. Railway espone `RAILWAY_VOLUME_MOUNT_PATH` e l'app lo usa da sola come cartella dati.
3. **Variables**: `NODE_ENV=production`, `APP_PASSWORD`, `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`.
4. **Settings → Networking → Generate Domain**, poi apri l'URL.

### Garanzie di persistenza e sicurezza
- Il database (`brain.db`) e gli allegati stanno **solo** in `DATA_DIR`/volume. All'avvio il log mostra `Dati in: …` e avvisa se la cartella non è configurata.
- **Snapshot giornaliero** del database in `DATA_DIR/backups` (ultimi 7), più «Esporta backup» (👤) per un JSON scaricabile.
- In produzione il server **rifiuta di avviarsi senza `APP_PASSWORD`** (altrimenti i tuoi dati sarebbero pubblici). Accesso con schermata di login, cookie di sessione firmato `HttpOnly`, limite ai tentativi, redirect HTTPS e HSTS.
- Le piattaforme fanno health check su `/api/health` e inviano SIGTERM ai riavvii: il server chiude il database in modo pulito.
- Il piano gratuito di alcune piattaforme mette in pausa il servizio dopo un periodo di inattività: la prima richiesta può essere lenta.

### Frontend su un dominio diverso (facoltativo)
Se vuoi ospitare `public/` altrove (Netlify, GitHub Pages…):
1. In `public/config.js` imposta `apiBase: 'https://<backend>.onrender.com'`.
2. Sul backend imposta `CORS_ORIGINS=https://<frontend>` (e `PUBLIC_API_URL` con l'URL del backend).
3. I cookie tra domini diversi possono essere bloccati dai browser (es. Safari): usa due sottodomini dello stesso sito, oppure resta sul servizio unico.

## App Android (APK) con pulsante di download
Un APK non si può generare dal solo codice: serve l'URL pubblico già online. L'app Android è un involucro (TWA) della tua PWA.

1. **Crea l'APK** (una volta, dopo il deploy):
   - *Senza installare nulla:* vai su **pwabuilder.com**, inserisci `https://<tuo-dominio>`, scegli **Package for stores → Android** e scarica lo zip. Contiene l'APK firmato, un file `signing-key-info` e l'impronta SHA-256.
   - *Da riga di comando:* `npm i -g @bubblewrap/cli`, poi `bubblewrap init --manifest https://<tuo-dominio>/manifest.webmanifest` e `bubblewrap build` (richiede JDK 17; l'Android SDK può scaricarlo da solo).
2. **Carica l'APK:** rinominalo `secondo-cervello.apk`, mettilo in `public/downloads/`, fai commit e redeploy.
3. **Schermo intero:** imposta su Render/Railway `ANDROID_SHA256_CERT` (l'impronta del punto 1) ed eventualmente `ANDROID_PACKAGE`. Il server pubblica `/.well-known/assetlinks.json`; senza, l'app mostra la barra del browser.
4. **Pulsante di download:** compare da solo nell'intestazione (📲 APK) e nella pagina `https://<tuo-dominio>/download.html`, da condividere. Finché l'APK non è caricato, il pulsante in app diventa «Installa» (installazione PWA) o resta nascosto.

Per installare l'APK fuori dal Play Store Android chiede di consentire le «origini sconosciute». Conserva con cura la chiave di firma: serve per gli aggiornamenti.

## Configurazione IA (`.env`)
| Scopo | Variabili |
|---|---|
| Claude | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| OpenAI / compatibili | `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` |
| IA locale (solo in locale) | `AI_PROVIDER=openai`, `OPENAI_BASE_URL=http://localhost:11434/v1` (Ollama) |
| Whisper | `STT_API_KEY` (o `OPENAI_API_KEY`), `STT_BASE_URL`, `STT_MODEL` |

Senza chiavi l'app funziona comunque con regole locali; la voce ripiega sulla dettatura del browser.

## Offline
Interfaccia e ultimo stato restano consultabili senza rete; le note di testo create offline vanno in coda (⏳) e si sincronizzano al ritorno senza duplicati. Coach, voce con Whisper e allegati richiedono la connessione.

## Struttura
```
server/index.js  API REST, auth, upload, backup, config runtime
server/ai.js     provider IA, Whisper, parsing con fallback, system prompt
server/db.js     schema SQLite: notes, reminders, user_context, attachments
public/          index.html, app.js, config.js, style.css, sw.js, manifest, icone, download.html, downloads/
render.yaml · railway.json   configurazioni di deploy
```
