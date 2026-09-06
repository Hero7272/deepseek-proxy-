/* Buch-Engine: Kapitel laufen per Cron weiter, auch wenn das Handy aus ist. */
const KIMI_URL = 'https://api.moonshot.ai/v1/chat/completions';
const MAX_VERSUCHE = 5;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-sw-pass, x-api-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE'
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...cors() }
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
  await env.BUCH_KV.put(jobKey(id), JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 14 });
}
function logZeile(job, text) {
  job.log = job.log || [];
  job.log.push({ zeit: new Date().toISOString(), text });
  if (job.log.length > 80) job.log.shift();
}

async function kimiAufruf(env, { system, user, model, maxTokens, apiKey }) {
  const key = String(apiKey || env.KIMI_KEY || '').trim();
  if (!key) throw new Error('Kein API-Key (Secret KIMI_KEY oder im Auftrag).');
  const modell = model || 'kimi-k2.6';
  const body = {
    model: modell,
    max_completion_tokens: Math.max(maxTokens || 4000, modell.includes('k2.6') ? 8000 : 4000),
    temperature: modell.includes('k2.6') ? 0.6 : 1,
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
  if (!r.ok) throw new Error('Kimi ' + r.status + ': ' + (await r.text()).slice(0, 280));
  const d = await r.json();
  const msg = d.choices && d.choices[0] && d.choices[0].message;
  const text = (msg && (msg.content || msg.reasoning_content)) || '';
  if (!String(text).trim()) throw new Error('Leere Antwort vom Modell.');
  return String(text).trim();
}

function kapitelPrompt(job) {
  const i = job.fertigBis || 0;
  const plan = job.plan[i];
  const bisher = (job.kapitel || []).map(k =>
    'K' + k.n + ' ' + k.titel + ':\n' + String(k.text || '').slice(-1800)
  ).join('\n\n');
  return (
    'Schreibe JETZT nur Kapitel ' + plan.n + ' "' + plan.titel + '".\n' +
    'Beat: ' + (plan.beat || '') + '\n' +
    'Zielumfang ca. ' + (job.kapitelZiel || 2200) + ' Woerter, deutsche Literatursprache, keine Ueberschrift Kapitel.\n\n' +
    (job.kontext ? ('KONTEXT:\n' + job.kontext + '\n\n') : '') +
    (bisher ? ('BEREITS GESCHRIEBEN:\n' + bisher.slice(-12000) + '\n\n') : '') +
    'Nur den Kapiteltext, keine Meta-Kommentare.'
  );
}

async function einenSchritt(env, job) {
  job.status = 'laeuft';
  job.versuch = (job.versuch || 0) + 1;
  const typ = job.typ || 'bibel';

  if (typ === 'lauf' || typ === 'kapitel') {
    const i = job.fertigBis || 0;
    if (!job.plan || i >= job.plan.length) {
      job.status = 'fertig';
      logZeile(job, 'Alle geplanten Kapitel fertig.');
      return;
    }
    const plan = job.plan[i];
    logZeile(job, 'Schreibe Kapitel ' + plan.n + ' "' + plan.titel + '" ...');
    await speichereJob(env, job.id, job);
    const text = await kimiAufruf(env, {
      system: job.system,
      user: kapitelPrompt(job),
      model: job.model,
      maxTokens: job.maxTokens || 6000,
      apiKey: job.apiKey
    });
    job.kapitel = job.kapitel || [];
    job.kapitel.push({ n: plan.n, titel: plan.titel, text, woerter: (text.match(/[\wÄÖÜäöüß'-]+/g) || []).length });
    job.fertigBis = i + 1;
    job.versuch = 0;
    logZeile(job, 'K' + plan.n + ' fertig (' + job.kapitel[job.kapitel.length - 1].woerter + ' Woerter).');
    if (job.fertigBis >= job.plan.length) {
      job.status = 'fertig';
      logZeile(job, 'Lauf abgeschlossen.');
    } else {
      job.status = 'wartet';
      logZeile(job, 'Naechstes Kapitel beim naechsten Takt.');
    }
    return;
  }

  logZeile(job, 'Versuch ' + job.versuch + ': Modellaufruf ...');
  await speichereJob(env, job.id, job);
  const roh = await kimiAufruf(env, {
    system: job.system, user: job.user, model: job.model,
    maxTokens: job.maxTokens, apiKey: job.apiKey
  });
  job.ergebnis = roh;
  job.status = 'fertig';
  logZeile(job, 'Fertig.');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    if (env.SW_PASS) {
      const pass = request.headers.get('x-sw-pass') || '';
      if (pass !== env.SW_PASS) return json({ fehler: 'Falsches Zugangswort' }, 403);
    }

    if (request.method === 'POST' && (url.pathname === '/start' || url.pathname === '/jobs')) {
      const e = await request.json();
      const id = e.jobId || ('j' + Date.now().toString(36));
      const job = {
        id, status: 'wartet', typ: e.typ || 'bibel',
        system: e.system || '', user: e.user || '',
        model: e.model || 'kimi-k2.6', maxTokens: e.maxTokens || 6000,
        kontext: e.kontext || '', plan: e.plan || [],
        kapitelZiel: e.kapitelZiel || 2200, projektId: e.projektId || '',
        apiKey: e.apiKey || '', kapitel: [], fertigBis: 0, versuch: 0, log: []
      };
      if ((job.typ === 'lauf' || job.typ === 'kapitel') && !job.plan.length) {
        return json({ fehler: 'plan[] fehlt' }, 400);
      }
      logZeile(job, 'Auftrag angelegt. Lauft auch bei ausgeschaltetem Handy weiter.');
      await speichereJob(env, id, job);
      const index = await ladeIndex(env);
      if (!index.includes(id)) { index.push(id); await speichereIndex(env, index); }
      ctx.waitUntil(einenSchritt(env, job).then(() => speichereJob(env, id, job)).catch(async err => {
        logZeile(job, 'Sofortstart: ' + err.message);
        job.status = 'wartet';
        await speichereJob(env, id, job);
      }));
      return json({ ok: true, jobId: id });
    }

    if (request.method === 'GET' && (url.pathname === '/status' || url.pathname === '/jobs')) {
      const id = url.searchParams.get('jobId');
      if (!id) return json({ fehler: 'jobId fehlt' }, 400);
      const job = await ladeJob(env, id);
      if (!job) return json({ fehler: 'Unbekannt' }, 404);
      const out = Object.assign({}, job);
      delete out.apiKey; delete out.system; delete out.user;
      return json(out);
    }

    if (request.method === 'DELETE' && url.pathname === '/jobs') {
      const id = url.searchParams.get('jobId');
      if (!id) return json({ fehler: 'jobId fehlt' }, 400);
      const job = await ladeJob(env, id);
      if (job) { job.status = 'stopp'; logZeile(job, 'Gestoppt.'); await speichereJob(env, id, job); }
      return json({ ok: true });
    }

    return json({ ok: true, dienst: 'buch-engine' });
  },

  async scheduled(event, env) {
    const index = await ladeIndex(env);
    if (!index.length) return;
    let changed = false;
    for (const id of index.slice()) {
      const job = await ladeJob(env, id);
      if (!job) { const i = index.indexOf(id); if (i > -1) { index.splice(i, 1); changed = true; } continue; }
      if (job.status === 'fertig' || job.status === 'fehler' || job.status === 'stopp') {
        const i = index.indexOf(id); if (i > -1) { index.splice(i, 1); changed = true; } continue;
      }
      if (job.status !== 'wartet' && job.status !== 'laeuft') continue;
      try { await einenSchritt(env, job); }
      catch (err) {
        logZeile(job, 'Fehler: ' + err.message);
        if ((job.versuch || 0) >= MAX_VERSUCHE) { job.status = 'fehler'; logZeile(job, 'Aufgegeben.'); }
        else job.status = 'wartet';
      }
      await speichereJob(env, id, job);
      if (job.status === 'fertig' || job.status === 'fehler' || job.status === 'stopp') {
        const i = index.indexOf(id); if (i > -1) { index.splice(i, 1); changed = true; }
      }
    }
    if (changed) await speichereIndex(env, index);
  }
};
