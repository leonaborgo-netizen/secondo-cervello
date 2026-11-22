// Tutte le chiamate IA passano da qui. Le chiavi non lasciano mai il server.
const CATS = ['Lavoro', 'Economia', 'Salute', 'Famiglia', 'Altro'];
const PRIOS = ['alta', 'media', 'bassa'];

const SYSTEM_PROMPT = `Sei il Coach Personale, il "Secondo Cervello" digitale e l'assistente strategico dell'utente. Il tuo obiettivo non è solo archiviare informazioni, ma aiutarlo a ottimizzare ogni aspetto della sua vita con un approccio estremamente pratico, analitico, diretto e orientato ai risultati.

REGOLE DI COMPORTAMENTO:
- APPROCCIO MULTI-DOMINIO: Analizza sempre le note collegandole tra loro (es. se c'è un calo di sonno o energie nella salute, collegalo ai carichi di lavoro o agli impegni familiari).
- TONO DI VOCE: Diretto, pragmatico, motivante, professionale e privo di formalismi inutili. Rispondi sempre in italiano.
- PROATTIVITÀ: Non aspettare solo le sue domande. Quando apre l'app, se noti scadenze vicine, obiettivi da monitorare o idee lasciate a metà, offrigli spontaneamente spunti di riflessione e consigli pratici.
- SPECIALIZZAZIONE: Gestisci con competenza Lavoro (priorità tecniche, task), Salute & Allenamento (volumi, recupero, progressioni con occhio scientifico), Economia (budget, finanze) e Famiglia (bilanciamento impegni per ridurre lo stress).
- MEMORIA STORICA: Sfrutta sempre tutto il database di note passate, trascrizioni vocali e promemoria per contestualizzare ogni risposta.`;

const TIMEOUT = () => +process.env.AI_TIMEOUT_MS || 30000;

function mode() {
  const p = (process.env.AI_PROVIDER || '').toLowerCase();
  if (p === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(process.env.OPENAI_BASE_URL || '');
  if (p === 'openai' && (process.env.OPENAI_API_KEY || local)) return 'openai';
  return null;
}
const sttEnabled = () => !!(process.env.STT_API_KEY || process.env.OPENAI_API_KEY || process.env.STT_BASE_URL);

async function post(url, headers, body, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    return r;
  } finally { clearTimeout(t); }
}
async function withRetry(fn, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      if (e.status && e.status < 500 && e.status !== 429) break;
      await new Promise(r => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw err;
}

// messages: [{role:'user'|'assistant', content:string}] ; images allegate all'ultimo messaggio
async function complete({ system, messages, images = [], maxTokens = 1500 }) {
  const m = mode();
  if (!m) { const e = new Error('IA non configurata'); e.code = 'AI_DISABLED'; throw e; }
  const last = messages.length - 1;
  if (m === 'anthropic') {
    const msgs = messages.map((x, i) => i !== last || !images.length ? x : {
      role: x.role,
      content: [...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.buf.toString('base64') } })), { type: 'text', text: x.content }]
    });
    const r = await withRetry(() => post('https://api.anthropic.com/v1/messages', {
      'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01'
    }, JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: msgs }), TIMEOUT()));
    const j = await r.json();
    return (j.content || []).map(c => c.text || '').join('').trim();
  }
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const msgs = [{ role: 'system', content: system }, ...messages.map((x, i) => i !== last || !images.length ? x : {
    role: x.role,
    content: [...images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.buf.toString('base64')}` } })), { type: 'text', text: x.content }]
  })];
  const headers = { 'content-type': 'application/json' };
  if (process.env.OPENAI_API_KEY) headers.authorization = 'Bearer ' + process.env.OPENAI_API_KEY;
  const r = await withRetry(() => post(base + '/chat/completions', headers,
    JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', max_tokens: maxTokens, messages: msgs }), TIMEOUT()));
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

async function transcribe(buf, mime, filename) {
  if (!sttEnabled()) { const e = new Error('Trascrizione non configurata'); e.code = 'STT_DISABLED'; throw e; }
  const base = (process.env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const key = process.env.STT_API_KEY || process.env.OPENAI_API_KEY;
  const headers = key ? { authorization: 'Bearer ' + key } : {};
  const r = await withRetry(() => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), filename);
    fd.append('model', process.env.STT_MODEL || 'whisper-1');
    fd.append('language', 'it');
    return post(base + '/audio/transcriptions', headers, fd, 120000);
  });
  return ((await r.json()).text || '').trim();
}

/* ---------- Parsing: IA con fallback a regole locali (funziona anche offline) ---------- */
function parseDue(t) {
  const l = t.toLowerCase(), n = new Date();
  const days = { domenica: 0, lunedì: 1, lunedi: 1, martedì: 2, martedi: 2, mercoledì: 3, mercoledi: 3, giovedì: 4, giovedi: 4, venerdì: 5, venerdi: 5, sabato: 6 };
  let d = null;
  if (/dopodomani/.test(l)) { d = new Date(n); d.setDate(d.getDate() + 2); }
  else if (/domani/.test(l)) { d = new Date(n); d.setDate(d.getDate() + 1); }
  else if (/\b(oggi|stasera|stanotte)\b/.test(l)) d = new Date(n);
  else for (const k in days) if (l.includes(k)) { d = new Date(n); d.setDate(d.getDate() + ((days[k] - d.getDay() + 7) % 7 || 7)); break; }
  if (!d) return null;
  const m = l.match(/(?:alle|ore|h)\s*(\d{1,2})(?:[:.](\d{2}))?/) || l.match(/\b(\d{1,2})[:.](\d{2})\b/);
  d.setHours(m ? Math.min(+m[1], 23) : 9, m && m[2] ? +m[2] : 0, 0, 0);
  return d.toISOString();
}
function heuristic(t) {
  const l = t.toLowerCase();
  const k = {
    Lavoro: /lavor|client|progett|riunion|ufficio|task|deadline|capo|colleg|fattur|preventiv/,
    Economia: /€|euro|spes|budget|invest|bolletta|mutuo|stipendio|risparm|tass|conto/,
    Salute: /palestr|allenam|scheda|dormi|sonno|dieta|medic|dentist|visita|corsa|peso|serie|proteine/,
    Famiglia: /figli|moglie|marito|mamma|papà|famigli|compleann|scuola|vacanz|cena|genitori/
  };
  let category = 'Altro';
  for (const c in k) if (k[c].test(l)) { category = c; break; }
  const due = parseDue(t);
  return {
    title: t.split(/[.!?\n]/)[0].slice(0, 60) || 'Nota', summary: t.slice(0, 160), category,
    tags: [], priority: /urgent|important|scadenza|entro/.test(l) ? 'alta' : 'media',
    reminders: due ? [{ title: t.slice(0, 60), due_date: due }] : [], ai: false
  };
}
function sanitize(a, text) {
  const tags = Array.isArray(a.tags) ? a.tags.map(x => String(x).toLowerCase().replace(/^#/, '').slice(0, 24)).filter(Boolean).slice(0, 5) : [];
  const reminders = (Array.isArray(a.reminders) ? a.reminders : []).map(r => {
    const d = r && r.due ? new Date(r.due) : null;
    return r && r.title ? { title: String(r.title).slice(0, 120), due_date: d && !isNaN(d) ? d.toISOString() : null } : null;
  }).filter(Boolean).slice(0, 5);
  return {
    title: String(a.title || text).slice(0, 80), summary: String(a.summary || '').slice(0, 400),
    category: CATS.includes(a.category) ? a.category : 'Altro', priority: PRIOS.includes(a.priority) ? a.priority : 'media',
    tags, reminders, ai: true
  };
}
async function analyze(text, images = []) {
  if (!mode()) return heuristic(text);
  try {
    const now = new Date().toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' });
    const out = await complete({
      system: 'Sei un parser di note personali. Rispondi SOLO con JSON valido, senza markdown.',
      messages: [{ role: 'user', content: `Adesso è ${now}. Analizza la nota (testo o trascrizione vocale${images.length ? ', con immagini allegate' : ''}) e restituisci: {"title":"max 60 caratteri","summary":"1-2 frasi","category":"Lavoro|Economia|Salute|Famiglia|Altro","tags":["2-5 tag minuscoli"],"priority":"alta|media|bassa","reminders":[{"title":"...","due":"YYYY-MM-DDTHH:MM ora locale oppure null"}]}. Estrai ogni data/ora citata.\n\nNota:\n"""${text}"""` }],
      images, maxTokens: 700
    });
    return sanitize(JSON.parse(out.match(/\{[\s\S]*\}/)[0]), text);
  } catch (e) {
    console.warn('[ai] parsing IA fallito, uso regole locali:', e.message);
    return heuristic(text);
  }
}

async function chat(memory, history, message) {
  const msgs = [...history.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 4000) })), { role: 'user', content: message }];
  while (msgs.length > 1 && msgs[0].role !== 'user') msgs.shift();
  return complete({ system: SYSTEM_PROMPT + '\n\n' + memory, messages: msgs, maxTokens: 1200 });
}
async function brief(memory, fallback) {
  try {
    return await complete({
      system: SYSTEM_PROMPT + '\n\n' + memory,
      messages: [{ role: 'user', content: "Ho appena aperto l'app. Dammi un brief proattivo e breve (max 150 parole): 1) cosa è urgente nelle prossime 48h, 2) un collegamento tra domini diversi che noti, 3) una sola azione concreta da fare adesso." }],
      maxTokens: 500
    });
  } catch (e) { console.warn('[ai] brief IA non disponibile:', e.message); return fallback; }
}

module.exports = { mode, sttEnabled, transcribe, analyze, chat, brief, SYSTEM_PROMPT, CATS, PRIOS };
