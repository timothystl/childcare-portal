const SUPABASE_URL = 'https://dahdstopsumxnqvdclmy.supabase.co';
const ALLOWED_ORIGINS = new Set(['https://mdo.timothystl.org']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const allowedOrigin = ALLOWED_ORIGINS.has(url.origin) ? url.origin : null;

    // Handle CORS preflight for /sb/* FIRST, before the proxy block
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/sb/')) {
      if (!allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin':  allowedOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, Prefer, X-Client-Info',
          'Access-Control-Max-Age':       '86400',
        },
      });
    }

    // Proxy /sb/* → Supabase (same-origin workaround for CORS)
    if (url.pathname.startsWith('/sb/')) {
      const supabasePath = url.pathname.slice(3); // strip /sb (keep leading /)
      const targetUrl = SUPABASE_URL + supabasePath + url.search;

      const proxyReq = new Request(targetUrl, {
        method:  request.method,
        headers: request.headers,
        body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });

      let supabaseRes;
      try {
        supabaseRes = await Promise.race([
          fetch(proxyReq),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Supabase request timed out')), 25000)
          ),
        ]);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 504,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': allowedOrigin ?? '',
          },
        });
      }

      const resHeaders = new Headers(supabaseRes.headers);
      resHeaders.set('Access-Control-Allow-Origin', url.origin);
      resHeaders.set('Access-Control-Allow-Credentials', 'true');

      return new Response(supabaseRes.body, {
        status:     supabaseRes.status,
        statusText: supabaseRes.statusText,
        headers:    resHeaders,
      });
    }

    // Rewrite /calendar → /calendar.html (avoids _redirects loop in Workers Assets)
    if (url.pathname === '/calendar') {
      const rewritten = new URL(request.url);
      rewritten.pathname = '/calendar.html';
      request = new Request(rewritten.toString(), request);
    }

    // Static assets
    const response    = await env.ASSETS.fetch(request);
    const newHeaders  = new Headers(response.headers);
    newHeaders.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net https://cloudflareinsights.com; " +
      "img-src 'self' data:; " +
      "font-src 'self' data:"
    );
    newHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');

    // Ensure service worker can claim full scope
    if (url.pathname === '/sw.js') {
      newHeaders.set('Service-Worker-Allowed', '/');
    }

    return new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers:    newHeaders,
    });
  },
};
