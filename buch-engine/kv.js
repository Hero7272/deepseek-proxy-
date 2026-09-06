export function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-sw-pass, x-api-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE'
  };
}
export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...cors() }
  });
}
export function jobKey(id) { return 'job:' + id; }
export const INDEX = 'jobindex';
export async function ladeIndex(env) {
  const raw = await env.BUCH_KV.get(INDEX);
  return raw ? JSON.parse(raw) : [];
}
export async function speichereIndex(env, liste) {
  await env.BUCH_KV.put(INDEX, JSON.stringify(liste));
}
export async function ladeJob(env, id) {
  const raw = await env.BUCH_KV.get(jobKey(id));
  return raw ? JSON.parse(raw) : null;
}
export async function speichereJob(env, id, job) {
  await env.BUCH_KV.put(jobKey(id), JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 21 });
}
export function logZeile(job, text) {
  job.log = job.log || [];
  job.log.push({ zeit: new Date().toISOString(), text });
  if (job.log.length > 120) job.log.shift();
}
export function words(t) { return (String(t || '').match(/[\wÄÖÜäöüß'-]+/g) || []).length; }
export function parseJSON(raw) {
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
