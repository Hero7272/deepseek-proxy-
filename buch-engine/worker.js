/* ===========================================================================
   BUCH-ENGINE — Etappe 1: Bibel-Erstellung dauerhaft im Hintergrund.
   Läuft als eigener Cloudflare Worker (nicht Pages Function), damit ein
   Cron Trigger genutzt werden kann. Arbeitet unabhängig davon, ob dein
   Handy/die App gerade offen ist.

   BENÖTIGTE EINRICHTUNG IM CLOUDFLARE-DASHBOARD (siehe Anleitung im Chat):
   - KV-Namespace, gebunden unter dem Namen BUCH_KV
   - Secret KIMI_KEY   = dein Kimi-API-Key
   - Secret SW_PASS    = dasselbe Zugangswort wie beim bisherigen Proxy
   - Cron Trigger: alle 1 Minute  ( * * * * * )
   =========================================================================== */

const KIMI_URL = 'https://api.moonshot.ai/v1/chat/completions';
const MAX_VERSUCHE = 6;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-sw-pass',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...cors() }
  });
}

// --- aus der App übernommen: robustes JSON-Herausschälen aus Modell-Antworten ---
function parseJSON(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('['), o = t.indexOf('{');
  const start = (a > -1 && (a < o || o === -1)) ? a : o;
  if (start < 0) throw new Error('Keine JSON-Struktur in der Antwort gefunden.');
  const open = t[start], close = open === '[' ? ']' : '}';
  let d = 0, ende = -1, str = false, escp = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (str) { if (escp) { escp = false; } else if (c === '\\') { escp = true; } else if (c === '"') { str = false; } continue; }
    if (c === '"') { str = true; continue; }
    if (c === open) d++;
    else if (c === close) { d--; if (d === 0) { ende = i; break; } }
  }
  if (ende < 0) { const e = new Error('JSON unvollständig — Antwort wurde vermutlich abgeschnitten.'); e.abgeschnitten = true; throw e; }
  return JSON.parse(t.slice(start, ende + 1));
}

async function kimiAufruf(env, { system, user, model, maxTokens }) {
  const body = {
    model: model || 'kimi-k2.6',
    max_completion_tokens: Math.max(maxTokens || 8000, 20000), // Kimi denkt immer intern nach — großzügiger Boden
    temperature: 1,
    stream: false,
    messages: []
  };
  if (system) body.messages.push({ role: 'system', content: system });
  body.messages.push({ role: 'user', content: user });

  const r = await fetch(KIMI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.KIMI_KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Kimi ${r.status}: ${txt.slice(0, 300)}`);
  }
  const d = await r.json();
  const text = d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
  if (!text) throw new Error('Leere Antwort vom Modell.');
  return text.trim();
}

function jobSchluessel(id) { return 'job:' + id; }
const INDEX_SCHLUESSEL = 'jobindex';

async function ladeIndex(env) {
  const raw = await env.BUCH_KV.get(INDEX_SCHLUESSEL);
  return raw ? JSON.parse(raw) : [];
}
async function speichereIndex(env, liste) {
  await env.BUCH_KV.put(INDEX_SCHLUESSEL, JSON.stringify(liste));
}
async function ladeJob(env, id) {
  const raw = await env.BUCH_KV.get(jobSchluessel(id));
  return raw ? JSON.parse(raw) : null;
}
async function speichereJob(env, id, job) {
  await env.BUCH_KV.put(jobSchluessel(id), JSON.stringify(job));
}
function logZeile(job, text) {
  job.log = job.log || [];
  job.log.push({ zeit: new Date().toISOString(), text });
  if (job.log.length > 50) job.log.shift();
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(request.url);

    if (env.SW_PASS) {
      const pass = request.headers.get('x-sw-pass') || '';
      if (pass !== env.SW_PASS) return json({ fehler: 'Falsches Zugangswort' }, 403);
    }

    // --- Job starten: legt in KV einen Auftrag an, der Worker macht den Rest selbst ---
    if (request.method === 'POST' && url.pathname === '/start') {
      const eingabe = await request.json();
      if (!eingabe.jobId || !eingabe.system || !eingabe.user) {
        return json({ fehler: 'jobId, system und user sind Pflichtfelder' }, 400);
      }
      const job = {
        id: eingabe.jobId,
        status: 'wartet',
        typ: eingabe.typ || 'bibel',
        system: eingabe.system,
        user: eingabe.user,
        model: eingabe.model || 'kimi-k2.6',
        maxTokens: eingabe.maxTokens || 8000,
        versuch: 0,
        ergebnis: null,
        log: []
      };
      logZeile(job, 'Auftrag angelegt — wird beim nächsten Zeittakt (spätestens in 60s) gestartet.');
      await speichereJob(env, job.id, job);
      const index = await ladeIndex(env);
      if (!index.includes(job.id)) { index.push(job.id); await speichereIndex(env, index); }
      return json({ ok: true, jobId: job.id });
    }

    // --- Status abfragen: die App fragt hier nach, ob es fertig ist ---
    if (request.method === 'GET' && url.pathname === '/status') {
      const id = url.searchParams.get('jobId');
      if (!id) return json({ fehler: 'jobId fehlt' }, 400);
      const job = await ladeJob(env, id);
      if (!job) return json({ fehler: 'Unbekannte jobId' }, 404);
      return json(job);
    }

    return json({ fehler: 'Unbekannter Pfad. Nutze POST /start oder GET /status?jobId=...' }, 404);
  },

  // --- Der eigentliche Hintergrund-Motor: läuft jede Minute von selbst,
  //     völlig unabhängig davon ob dein Handy an, aus, im Hintergrund oder
  //     die App geschlossen ist. ---
  async scheduled(event, env, ctx) {
    const index = await ladeIndex(env);
    if (!index.length) return;
    let indexGeaendert = false;

    for (const id of index.slice()) {
      const job = await ladeJob(env, id);
      if (!job) { const i = index.indexOf(id); if (i>-1){ index.splice(i,1); indexGeaendert = true; } continue; }
      if (job.status !== 'wartet' && job.status !== 'läuft') {
        // fertig oder endgültig gescheitert — aus der aktiven Liste nehmen, Ergebnis bleibt trotzdem in KV gespeichert und über /status abrufbar
        const i = index.indexOf(id); if (i>-1){ index.splice(i,1); indexGeaendert = true; }
        continue;
      }

      job.status = 'läuft';
      job.versuch = (job.versuch || 0) + 1;
      try {
        logZeile(job, `Versuch ${job.versuch}: Anfrage an Kimi läuft …`);
        await speichereJob(env, job.id, job); // Zwischenspeichern, bevor der (evtl. lange) Aufruf startet

        const roh = await kimiAufruf(env, { system: job.system, user: job.user, model: job.model, maxTokens: job.maxTokens });
        const ergebnis = parseJSON(roh);

        job.ergebnis = ergebnis;
        job.status = 'fertig';
        logZeile(job, 'Fertig — Ergebnis gespeichert.');
      } catch (e) {
        logZeile(job, 'Fehler: ' + e.message);
        if (job.versuch >= MAX_VERSUCHE) {
          job.status = 'fehler';
          logZeile(job, `Nach ${MAX_VERSUCHE} Versuchen aufgegeben.`);
        } else {
          job.status = 'wartet'; // nächster Cron-Takt versucht es automatisch erneut
        }
      }
      await speichereJob(env, job.id, job);
      if (job.status === 'fertig' || job.status === 'fehler') {
        const i = index.indexOf(id); if (i>-1){ index.splice(i,1); indexGeaendert = true; }
      }
    }
    if (indexGeaendert) await speichereIndex(env, index);
  }
};
