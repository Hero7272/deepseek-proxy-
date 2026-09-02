// Cloudflare Worker — Proxy zwischen der DeepSeek-Werkstatt-App und der DeepSeek-API.
// Löst zwei Probleme auf einmal:
// 1. DeepSeek blockt Aufrufe direkt aus dem Browser (CORS) — der Worker ruft stattdessen serverseitig auf.
// 2. Kein Zeitlimit wie bei Vercel-Serverless-Funktionen auf dem Hobby-Plan — Worker geben
//    den Stream einfach durch, ohne die Antwort selbst zu puffern.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-api-key, x-sw-pass',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Nur POST erlaubt.', { status: 405, headers: CORS });
    }

    // Zugangswort prüfen (im Cloudflare-Dashboard als Secret SW_PASS hinterlegt).
    // Wenn kein SW_PASS gesetzt ist, ist der Worker offen — für den privaten Gebrauch
    // mit geheimer Worker-URL okay, für alles andere: SW_PASS setzen.
    if (env.SW_PASS) {
      const pass = request.headers.get('x-sw-pass') || '';
      if (pass !== env.SW_PASS) {
        return new Response('Zugangswort stimmt nicht.', { status: 403, headers: CORS });
      }
    }

    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return new Response('Kein API-Key übergeben (Header x-api-key fehlt).', { status: 400, headers: CORS });
    }

    let upstream;
    try {
      upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: request.body,
      });
    } catch (e) {
      return new Response('DeepSeek nicht erreichbar: ' + e.message, { status: 502, headers: CORS });
    }

    // Antwort (inkl. SSE-Stream) unverändert durchreichen, nur CORS-Header ergänzen.
    const headers = new Headers(CORS);
    headers.set('content-type', upstream.headers.get('content-type') || 'application/json');

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
