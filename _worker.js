export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-api-key, x-sw-pass, x-sw-target',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Nur POST', { status: 405, headers: cors });

    if (env.SW_PASS) {
      const pass = request.headers.get('x-sw-pass') || '';
      if (pass !== env.SW_PASS) return new Response('Falsches Passwort', { status: 403, headers: cors });
    }

    const apiKey = (request.headers.get('x-api-key') || env.KIMI_KEY || env.API_KEY || '').trim();
    const ziel = request.headers.get('x-sw-target');
    if (!apiKey) return new Response('Kein API-Key (Header oder Secret)', { status: 400, headers: cors });
    if (!ziel) return new Response('Kein x-sw-target Header', { status: 400, headers: cors });

    const upstream = await fetch(ziel, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
      body: request.body,
      duplex: 'half'
    });

    const headers = new Headers(upstream.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
