export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-api-key, x-sw-pass, x-sw-target',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Nur POST', { status: 405, headers: cors });

    // Optionaler Passwortschutz, damit nicht irgendwer deinen Worker mitbenutzt.
    // In Cloudflare unter Worker -> Settings -> Variables als Secret "WORKER_PASS" anlegen.
    if (env.WORKER_PASS) {
      const pass = request.headers.get('x-sw-pass') || '';
      if (pass !== env.WORKER_PASS) return new Response('Falsches Passwort', { status: 401, headers: cors });
    }

    const apiKey = request.headers.get('x-api-key');
    const ziel = request.headers.get('x-sw-target');
    if (!apiKey) return new Response('Kein x-api-key Header', { status: 400, headers: cors });
    if (!ziel) return new Response('Kein x-sw-target Header', { status: 400, headers: cors });

    const upstream = await fetch(ziel, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
      body: request.body
    });

    const headers = new Headers(upstream.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
