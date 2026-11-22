require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, UP, DATA } = require('./db');
const ai = require('./ai');

const app = express();
app.disable('x-powered-by');

/* ---------- Ambiente cloud ---------- */
const PROD = process.env.NODE_ENV === 'production';
const PW = process.env.APP_PASSWORD || '';
const PUBLIC_API = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
const ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
if (PROD && !PW && process.env.ALLOW_NO_AUTH !== '1') {
  console.error('ERRORE: in produzione serve APP_PASSWORD, altrimenti i tuoi dati sarebbero pubblici. Impostala (oppure ALLOW_NO_AUTH=1 a tuo rischio).');
  process.exit(1);
}
app.set('trust proxy', PROD ? 1 : false);
if (PROD) app.use((req, res, next) => {            // HTTPS obbligatorio dietro il proxy della piattaforma
  if (req.headers['x-forwarded-proto'] === 'http' && req.path !== '/api/health') return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

/* ---------- Sicurezza di base ---------- */
let apiOrigin = ''; try { if (PUBLIC_API) apiOrigin = ' ' + new URL(PUBLIC_API).origin; } catch {}
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' blob: data:${apiOrigin}; media-src 'self' blob:${apiOrigin}; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'${apiOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
  });
  next();
});
app.use((req, res, next) => {                      // CORS solo per frontend ospitati altrove (CORS_ORIGINS)
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '1mb' }));

/* ---------- Autenticazione: login + cookie di sessione firmato (stateless) ---------- */
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('sc:' + PW).digest('hex');
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const mkToken = () => { const exp = String(Date.now() + 30 * 864e5); return exp + '.' + sign(exp); };
function okToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const getCookie = (req, n) => ((req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(n + '=')) || '').slice(n.length + 1);
const h256 = x => crypto.createHash('sha256').update(String(x)).digest();
const tries = new Map();
const cookieOpts = req => ({ httpOnly: true, secure: PROD || req.secure, sameSite: ORIGINS.length ? 'none' : 'lax', path: '/' });
app.post('/api/login', (req, res) => {
  if (!PW) return res.json({ ok: true });
  const now = Date.now(), t = (tries.get(req.ip) || []).filter(x => now - x < 15 * 60e3);
  if (t.length >= 10) return res.status(429).json({ error: 'Troppi tentativi: riprova tra qualche minuto' });
  if (!crypto.timingSafeEqual(h256(req.body?.password || ''), h256(PW))) {
    t.push(now); tries.set(req.ip, t); if (tries.size > 1000) tries.clear();
    return res.status(401).json({ error: 'Password errata' });
  }
  res.cookie('sc_session', mkToken(), { ...cookieOpts(req), maxAge: 30 * 864e5 });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('sc_session', cookieOpts(req)); res.json({ ok: true }); });
app.use('/api', (req, res, next) => {
  if (!PW || req.method === 'OPTIONS' || req.path === '/health' || req.path === '/login') return next();
  if (okToken(getCookie(req, 'sc_session'))) return next();
  res.status(401).json({ error: 'Autenticazione richiesta' });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 8 } });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const safeJSON = s => { try { return JSON.parse(s); } catch { return []; } };
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ---------- Helpers dati ---------- */
function state() {
  const notes = db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 500').all().map(n => ({ ...n, tags: safeJSON(n.tags) }));
  const by = {};
  for (const f of db.prepare('SELECT id, note_id, original_name AS name, mime, size FROM attachments').all())
    (by[f.note_id] ??= []).push({ ...f, url: `/api/files/${f.id}` });
  notes.forEach(n => { n.files = by[n.id] || []; });
  const reminders = db.prepare('SELECT * FROM reminders ORDER BY is_completed, due_date IS NULL, due_date').all()
    .map(r => ({ ...r, is_completed: !!r.is_completed }));
  const context = Object.fromEntries(db.prepare('SELECT key, value FROM user_context').all().map(r => [r.key, r.value]));
  return { notes, reminders, context };
}
function memory() {
  const s = state();
  const N = s.notes.slice(0, 60).map(n => `- [${n.category}|${n.priority}|${n.created_at.slice(0, 10)}] ${n.title}: ${n.content.slice(0, 300)}${n.files.length ? ` [allegati: ${n.files.map(f => f.name).join(', ')}]` : ''}`).join('\n');
  const R = s.reminders.filter(r => !r.is_completed).map(r => `- ${r.title} (${r.due_date || 'senza data'})`).join('\n');
  return `DATA E ORA: ${new Date().toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' })}\n\nCONTESTO UTENTE (UserContext):\n${s.context.profile || '(non impostato)'}\n\nNOTE RECENTI:\n${N || '(nessuna)'}\n\nPROMEMORIA APERTI:\n${R || '(nessuno)'}`;
}
function localBrief() {
  const open = state().reminders.filter(r => !r.is_completed && r.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5);
  if (!open.length) return 'Nessuna scadenza imminente. Scegli un obiettivo e aggiungi una nota per iniziare.\n(IA non raggiungibile: brief generato localmente.)';
  const now = Date.now();
  return 'Prossime scadenze:\n' + open.map(r => `${new Date(r.due_date) < now ? '⚠️ scaduto' : '•'} ${r.title} — ${new Date(r.due_date).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`).join('\n') + '\n\n(IA non raggiungibile: brief generato localmente.)';
}
function storeFile(f) {
  const ext = path.extname(f.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const stored = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(UP, stored), f.buffer);
  return { stored, name: Buffer.from(f.originalname || 'file', 'latin1').toString('utf8').slice(0, 120), mime: f.mimetype || 'application/octet-stream', size: f.size };
}
const blocked = f => /svg|html|javascript/i.test(f.mimetype || '') || /\.(svg|html?|js)$/i.test(f.originalname || '');

/* ---------- API ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, ai: !!ai.mode(), stt: ai.sttEnabled(), auth: !!PW }));
app.get('/api/state', (req, res) => res.json(state()));
app.get('/api/export', (req, res) => { res.set('Content-Disposition', 'attachment; filename="secondo-cervello-backup.json"'); res.json(state()); });

app.post('/api/notes', upload.array('files', 8), wrap(async (req, res) => {
  const content = String(req.body.content || '').trim().slice(0, 20000);
  const files = (req.files || []).filter(f => !blocked(f));
  const clientId = req.body.client_id ? String(req.body.client_id).slice(0, 64) : null;
  if (!content && !files.length) return bad(res, 'Nota vuota');
  if (clientId && db.prepare('SELECT 1 FROM notes WHERE client_id = ?').get(clientId)) return res.json(state()); // idempotente
  const text = content || 'Nota con allegati: ' + files.map(f => f.originalname).join(', ');
  const imgs = files.filter(f => /^image\/(jpeg|png|webp|gif)$/.test(f.mimetype)).slice(0, 4).map(f => ({ mime: f.mimetype, buf: f.buffer }));
  const a = await ai.analyze(text, imgs);
  const saved = files.map(storeFile);
  try {
    db.transaction(() => {
      const nid = db.prepare('INSERT INTO notes (client_id, content, title, summary, category, priority, tags) VALUES (?,?,?,?,?,?,?)')
        .run(clientId, text, a.title, a.summary, a.category, a.priority, JSON.stringify(a.tags)).lastInsertRowid;
      const insF = db.prepare('INSERT INTO attachments (note_id, original_name, stored_name, mime, size) VALUES (?,?,?,?,?)');
      for (const s of saved) {
        const fid = insF.run(nid, s.name, s.stored, s.mime, s.size).lastInsertRowid;
        if (s.mime.startsWith('audio/')) db.prepare('UPDATE notes SET audio_url = COALESCE(audio_url, ?) WHERE id = ?').run(`/api/files/${fid}`, nid);
      }
      const insR = db.prepare('INSERT INTO reminders (note_id, title, due_date) VALUES (?,?,?)');
      for (const r of a.reminders) insR.run(nid, r.title, r.due_date);
    })();
  } catch (e) { saved.forEach(s => fs.rmSync(path.join(UP, s.stored), { force: true })); throw e; }
  res.json({ ...state(), ai: a.ai });
}));

app.patch('/api/notes/:id', wrap(async (req, res) => {
  const b = req.body || {}, sets = [], vals = [];
  if (b.category !== undefined) { if (!ai.CATS.includes(b.category)) return bad(res, 'Categoria non valida'); sets.push('category = ?'); vals.push(b.category); }
  if (b.priority !== undefined) { if (!ai.PRIOS.includes(b.priority)) return bad(res, 'Priorità non valida'); sets.push('priority = ?'); vals.push(b.priority); }
  for (const k of ['title', 'summary', 'content']) if (typeof b[k] === 'string') { sets.push(`${k} = ?`); vals.push(b[k].slice(0, k === 'content' ? 20000 : 400)); }
  if (Array.isArray(b.tags)) { sets.push('tags = ?'); vals.push(JSON.stringify(b.tags.map(String).slice(0, 8))); }
  if (!sets.length) return bad(res, 'Nessuna modifica');
  const r = db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  if (!r.changes) return bad(res, 'Nota non trovata', 404);
  res.json(state());
}));

app.delete('/api/notes/:id', wrap(async (req, res) => {
  const files = db.prepare('SELECT stored_name FROM attachments WHERE note_id = ?').all(req.params.id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  files.forEach(f => fs.rmSync(path.join(UP, f.stored_name), { force: true }));
  res.json(state());
}));

app.post('/api/notes/:id/files', upload.array('files', 8), wrap(async (req, res) => {
  if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(req.params.id)) return bad(res, 'Nota non trovata', 404);
  const saved = (req.files || []).filter(f => !blocked(f)).map(storeFile);
  const ins = db.prepare('INSERT INTO attachments (note_id, original_name, stored_name, mime, size) VALUES (?,?,?,?,?)');
  db.transaction(() => saved.forEach(s => ins.run(req.params.id, s.name, s.stored, s.mime, s.size)))();
  res.json(state());
}));

app.get('/api/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!f) return res.sendStatus(404);
  const inline = /^(image\/(jpeg|png|webp|gif)|audio\/|application\/pdf)/.test(f.mime);
  res.set({ 'Content-Type': inline ? f.mime : 'application/octet-stream', 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}` });
  res.sendFile(path.join(UP, f.stored_name), e => { if (e && !res.headersSent) res.sendStatus(404); });
});

app.post('/api/reminders', wrap(async (req, res) => {
  const { title, due_date, note_id } = req.body || {};
  const d = due_date ? new Date(due_date) : null;
  if (!title || (d && isNaN(d))) return bad(res, 'Dati non validi');
  db.prepare('INSERT INTO reminders (note_id, title, due_date) VALUES (?,?,?)').run(note_id || null, String(title).slice(0, 120), d ? d.toISOString() : null);
  res.json(state());
}));
app.patch('/api/reminders/:id', wrap(async (req, res) => {
  const b = req.body || {}, sets = [], vals = [];
  if (b.is_completed !== undefined) { sets.push('is_completed = ?'); vals.push(b.is_completed ? 1 : 0); }
  if (b.due_date !== undefined) { const d = b.due_date ? new Date(b.due_date) : null; if (d && isNaN(d)) return bad(res, 'Data non valida'); sets.push('due_date = ?'); vals.push(d ? d.toISOString() : null); }
  if (typeof b.title === 'string' && b.title) { sets.push('title = ?'); vals.push(b.title.slice(0, 120)); }
  if (!sets.length) return bad(res, 'Nessuna modifica');
  const r = db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  if (!r.changes) return bad(res, 'Promemoria non trovato', 404);
  res.json(state());
}));
app.delete('/api/reminders/:id', wrap(async (req, res) => { db.prepare('DELETE FROM reminders WHERE id = ?').run(req.params.id); res.json(state()); }));

app.put('/api/context', wrap(async (req, res) => {
  db.prepare("INSERT INTO user_context (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    .run(String(req.body?.profile || '').slice(0, 10000));
  res.json(state());
}));

app.post('/api/transcribe', upload.single('audio'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 'Audio mancante');
  try { res.json({ text: await ai.transcribe(req.file.buffer, req.file.mimetype || 'audio/webm', req.file.originalname || 'nota.webm') }); }
  catch (e) { if (e.code === 'STT_DISABLED') return bad(res, e.message, 501); console.warn('[stt]', e.message); bad(res, 'Trascrizione non riuscita: ' + e.message, 502); }
}));

app.post('/api/chat', wrap(async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 4000);
  if (!message) return bad(res, 'Messaggio vuoto');
  try { res.json({ reply: await ai.chat(memory(), Array.isArray(req.body.history) ? req.body.history : [], message) }); }
  catch (e) { console.warn('[chat]', e.message); bad(res, e.code === 'AI_DISABLED' ? 'Il coach IA non è configurato sul server (vedi .env).' : 'Il coach non è raggiungibile al momento. Riprova tra poco.', 503); }
}));
app.post('/api/brief', wrap(async (req, res) => res.json({ brief: await ai.brief(memory(), localBrief()) })));

app.use('/api', (req, res) => bad(res, 'Endpoint non trovato', 404));

/* ---------- App Android (APK) ---------- */
const APK = path.join(__dirname, '..', 'public', 'downloads', 'secondo-cervello.apk');
app.get('/download/secondo-cervello.apk', (req, res) => {
  if (!fs.existsSync(APK)) return res.sendStatus(404);
  res.download(APK, 'secondo-cervello.apk', { headers: { 'Content-Type': 'application/vnd.android.package-archive', 'Cache-Control': 'no-cache' } });
});
// Digital Asset Links: permette all'app Android (TWA) di aprirsi a schermo intero, senza barra del browser
app.get('/.well-known/assetlinks.json', (req, res) => {
  const sha = (process.env.ANDROID_SHA256_CERT || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!sha.length) return res.sendStatus(404);
  res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: process.env.ANDROID_PACKAGE || 'com.secondocervello.app', sha256_cert_fingerprints: sha } }]);
});

/* ---------- Configurazione runtime del frontend ---------- */
app.get('/config.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache')
  .send(`globalThis.APP_CONFIG=${JSON.stringify({ apiBase: PUBLIC_API })};`));

/* ---------- Frontend statico ---------- */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); }
}));

/* ---------- Errori ---------- */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'File troppo grande (max 25 MB)' : err.message, 413);
  if (err.type === 'entity.parse.failed') return bad(res, 'JSON non valido');
  console.error('[errore]', err);
  bad(res, 'Errore interno del server', 500);
});

const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || (PROD ? '0.0.0.0' : '127.0.0.1');
const server = app.listen(PORT, HOST, () => {
  console.log(`Secondo Cervello su http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`IA: ${ai.mode() || 'non configurata (regole locali)'} · Trascrizione: ${ai.sttEnabled() ? 'attiva' : 'non configurata'}${process.env.APP_PASSWORD ? ' · Password attiva' : ''}`);
});
if (PROD && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH)
  console.warn('⚠️  DATA_DIR non impostato: se il disco non è persistente perderai i dati a ogni deploy.');
console.log('Dati in:', DATA);

// Snapshot giornaliero del database (ultimi 7), coerente anche con scritture in corso
function snapshot() {
  const dir = path.join(DATA, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'brain-' + new Date().toISOString().slice(0, 10) + '.db');
  if (fs.existsSync(f)) return;
  db.backup(f).then(() => fs.readdirSync(dir).filter(x => x.endsWith('.db')).sort().slice(0, -7).forEach(x => fs.rmSync(path.join(dir, x), { force: true })))
    .catch(e => console.warn('[backup]', e.message));
}
if (process.env.BACKUP !== '0') { setTimeout(snapshot, 5000).unref(); setInterval(snapshot, 6 * 3600e3).unref(); }

const stop = () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 5000).unref(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
