const SUPABASE_URL = 'https://dahdstopsumxnqvdclmy.supabase.co';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Proxy /sb/* → Supabase (same-origin workaround for CORS)
    if (url.pathname.startsWith('/sb/')) {
      const supabasePath = url.pathname.slice(3); // strip /sb (keep leading /)
      const targetUrl = SUPABASE_URL + supabasePath + url.search;

      const proxyReq = new Request(targetUrl, {
        method:  request.method,
        headers: request.headers,
        body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });

      const supabaseRes = await fetch(proxyReq);
      const resHeaders  = new Headers(supabaseRes.headers);
      resHeaders.set('Access-Control-Allow-Origin', url.origin);
      resHeaders.set('Access-Control-Allow-Credentials', 'true');

      return new Response(supabaseRes.body, {
        status:     supabaseRes.status,
        statusText: supabaseRes.statusText,
        headers:    resHeaders,
      });
    }

    // Handle CORS preflight for /sb/*
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/sb/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin':  url.origin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, Prefer, X-Client-Info',
          'Access-Control-Max-Age':       '86400',
        },
      });
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
    return new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers:    newHeaders,
    });
  },
};
