/* Buch-Engine mit Gehirn: Reflexion, Entwurf, Audit, Faeden, State. Ein Schritt pro Cron. */
const KIMI_URL = 'https://api.moonshot.ai/v1/chat/completions';
const MAX_VERSUCHE = 5;
const MAX_AUDIT = 2;
const MAX_FAEDEN = 4;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-sw-pass, x-api-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE'
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...cors() }
  });
}
function jobKey(id) { return 'job:' + id; }
const INDEX = 'jobindex';
async function ladeIndex(env) {
  const raw = await env.BUCH_KV.get(INDEX);
  return raw ? JSON.parse(raw) : [];
}
async function speichereIndex(env, liste) {
  await env.BUCH_KV.put(INDEX, JSON.stringify(liste));
}
async function ladeJob(env, id) {
  const raw = await env.BUCH_KV.get(jobKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function speichereJob(env, id, job) {
  await env.BUCH_KV.put(jobKey(id), JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 21 });
}
function logZeile(job, text) {
  job.log = job.log || [];
  job.log.push({ zeit: new Date().toISOString(), text });
  if (job.log.length > 120) job.log.shift();
}
function words(t) { return (String(t || '').match(/[\wÄÖÜäöüß'-]+/g) || []).length; }

function parseJSON(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('['), o = t.indexOf('{');
  const start = (a > -1 && (a < o || o === -1)) ? a : o;
  if (start < 0) throw new Error('Kein JSON');
  const open = t[start], close = open === '[' ? ']' : '}';
  let d = 0, ende = -1, str = false, escp = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (str) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; continue; }
    if (c === open) d++;
    else if (c === close) { d--; if (d === 0) { ende = i; break; } }
  }
  if (ende < 0) throw new Error('JSON unvollstaendig');
  return JSON.parse(t.slice(start, ende + 1));
}

async function kimi(env, job, { system, user, maxTokens, temp }) {
  const key = String(job.apiKey || env.KIMI_KEY || '').trim();
  if (!key) throw new Error('Kein API-Key');
  const modell = job.model || 'kimi-k2.6';
  const body = {
    model: modell,
    max_completion_tokens: Math.max(maxTokens || 4000, /k2\.6/i.test(modell) ? 8000 : 4000),
    temperature: temp != null ? temp : (/k2\.6/i.test(modell) ? 0.6 : 0.9),
    stream: false,
    messages: []
  };
  if (/kimi-k2\.6/i.test(modell)) body.thinking = { type: 'disabled' };
  if (system) body.messages.push({ role: 'system', content: system });
  body.messages.push({ role: 'user', content: user });
  const r = await fetch(KIMI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Kimi ' + r.status + ': ' + (await r.text()).slice(0, 240));
  const d = await r.json();
  const msg = d.choices && d.choices[0] && d.choices[0].message;
  const text = (msg && (msg.content || '')) || '';
  if (!String(text).trim()) throw new Error('Leere Antwort');
  return String(text).trim();
}
