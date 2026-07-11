const SUPABASE_URL = 'https://dahdstopsumxnqvdclmy.supabase.co';
const ALLOWED_ORIGINS = new Set(['https://mdo.timothystl.org']);

// ── Web Push helpers (RFC 8291 / RFC 8188) ───────────────────────────────────

function concatU8(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - str.length % 4) % 4);
  return Uint8Array.from(
    atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad),
    c => c.charCodeAt(0)
  );
}

function b64urlEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// HKDF-SHA-256: Extract then single-block Expand (L ≤ 32)
async function hkdf(salt, ikm, info, len) {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concatU8(info, new Uint8Array([1])));
  return okm.slice(0, len);
}

// Encrypt a push payload per RFC 8291 (aes128gcm content encoding)
async function encryptWebPush(plaintext, p256dhB64, authB64) {
  const te    = new TextEncoder();
  const uaPub = b64urlDecode(p256dhB64);  // subscription p256dh, 65 bytes
  const auth  = b64urlDecode(authB64);    // subscription auth, 16 bytes

  // Ephemeral sender ECDH key pair
  const senderKP = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // ECDH shared secret + sender public key
  const dh    = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, senderKP.privateKey, 256));
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', senderKP.publicKey));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // IKM = HKDF(salt=auth, ikm=dh, info="WebPush: info\0"||uaPub||asPub, len=32)
  const ikm = await hkdf(
    auth, dh,
    concatU8(te.encode('WebPush: info\0'), uaPub, asPub),
    32
  );

  // CEK (16 bytes) and Nonce (12 bytes) from random salt + IKM
  const cek   = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'),     12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);

  // Pad: plaintext || 0x02 (last-record delimiter, no extra padding)
  const msg    = te.encode(typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext));
  const padded = concatU8(msg, new Uint8Array([2]));

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, cekKey, padded));

  // RFC 8188 header: salt(16) | rs(4,BE) | keylen(1) | senderPub(65)
  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(asPub, 21);

  return concatU8(header, ciphertext);
}

// Build a VAPID JWT for the Authorization header
async function vapidJwt(endpoint, subject, privateKeyJwk) {
  const te  = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const { origin } = new URL(endpoint);
  const toB64 = o => btoa(JSON.stringify(o))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = `${toB64({ typ: 'JWT', alg: 'ES256' })}.${toB64({ aud: origin, exp: now + 43200, sub: subject })}`;
  const key = await crypto.subtle.importKey(
    'jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned)));
  return `${unsigned}.${b64urlEncode(sig)}`;
}

// Send a single Web Push notification to one subscription
async function sendWebPush(sub, payload, env) {
  const privateKeyJwk = JSON.parse(env.VAPID_PRIVATE_KEY);
  const jwt  = await vapidJwt(sub.endpoint, env.VAPID_SUBJECT, privateKeyJwk);
  const body = await encryptWebPush(JSON.stringify(payload), sub.p256dh, sub.auth);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
    },
    body,
  });
}

// Verifies a family session token issued by the family-lookup Edge Function.
// Token format: "{familyId}:{expiryMs}:{b64url(HMAC-SHA256(secret, familyId:expiryMs))}"
async function verifyFamilyToken(token, secret, expectedFamilyId) {
  try {
    const parts = token.split(':');
    if (parts.length !== 3) return false;
    const [tokenFamilyId, expStr, sig] = parts;
    if (tokenFamilyId !== expectedFamilyId) return false;
    if (Date.now() > parseInt(expStr, 10)) return false;
    const keyBytes = new TextEncoder().encode(secret);
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const sigBytes = b64urlDecode(sig);
    const msg = new TextEncoder().encode(`${tokenFamilyId}:${expStr}`);
    return crypto.subtle.verify('HMAC', key, sigBytes, msg);
  } catch {
    return false;
  }
}

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
      resHeaders.set('Access-Control-Allow-Origin', allowedOrigin ?? '');
      resHeaders.set('Access-Control-Allow-Credentials', 'true');

      return new Response(supabaseRes.body, {
        status:     supabaseRes.status,
        statusText: supabaseRes.statusText,
        headers:    resHeaders,
      });
    }

    // ── POST /push-subscribe — save a push subscription for a family ────────
    if (url.pathname === '/push-subscribe' && request.method === 'POST') {
      const { family_id, endpoint, p256dh, auth } = await request.json().catch(() => ({}));
      if (!family_id || !endpoint || !p256dh || !auth) {
        return new Response('Missing fields', { status: 400 });
      }

      // Require a valid HMAC session token to prevent unauthenticated registrations.
      const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const tokenOk = bearer
        ? await verifyFamilyToken(bearer, env.FAMILY_SESSION_SECRET ?? '', family_id)
        : false;
      if (!tokenOk) return new Response('Unauthorized', { status: 401 });
      const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions`, {
        method:  'POST',
        headers: {
          'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates',
        },
        body: JSON.stringify({ family_id, endpoint, p256dh, auth }),
      });
      return new Response(null, { status: res.ok ? 201 : 500 });
    }

    // ── POST /staff-push-subscribe — save a push subscription for a staff member ──
    if (url.pathname === '/staff-push-subscribe' && request.method === 'POST') {
      const { staff_id, endpoint, p256dh, auth } = await request.json().catch(() => ({}));
      if (!staff_id || !endpoint || !p256dh || !auth) {
        return new Response('Missing fields', { status: 400 });
      }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/staff_push_subscriptions`, {
        method:  'POST',
        headers: {
          'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates',
        },
        body: JSON.stringify({ staff_id, endpoint, p256dh, auth }),
      });
      return new Response(null, { status: res.ok ? 201 : 500 });
    }

    // ── POST /send-staff-push — send a notification to a staff member ────────
    if (url.pathname === '/send-staff-push' && request.method === 'POST') {
      // Require service role key or internal key to prevent abuse
      const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (bearer !== env.SUPABASE_SERVICE_ROLE_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }

      const { staff_id, title, body: msgBody } = await request.json().catch(() => ({}));
      if (!staff_id || !title) return new Response('Missing fields', { status: 400 });

      const subsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staff_push_subscriptions?staff_id=eq.${encodeURIComponent(staff_id)}&select=*`,
        { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (!subsRes.ok) return new Response('Failed to fetch subscriptions', { status: 500 });

      const subs = await subsRes.json();
      if (!subs.length) return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });

      const results = await Promise.allSettled(
        subs.map(sub => sendWebPush(sub, { title, body: msgBody }, env))
      );

      // Remove expired (410 Gone) subscriptions
      const expired = subs
        .filter((_, i) => results[i].status === 'fulfilled' && results[i].value.status === 410)
        .map(s => s.id);
      if (expired.length) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/staff_push_subscriptions?id=in.(${expired.join(',')})`,
          { method: 'DELETE', headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
      }

      const sent = subs.length - expired.length;
      return new Response(JSON.stringify({ sent }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── POST /send-push — send a notification (admin only) ──────────────────
    if (url.pathname === '/send-push' && request.method === 'POST') {
      // Reject cross-origin requests to prevent a logged-in admin's browser
      // from being tricked into sending fake notifications via CSRF.
      const reqOrigin = request.headers.get('Origin');
      if (reqOrigin && !ALLOWED_ORIGINS.has(reqOrigin)) {
        return new Response('Forbidden', { status: 403 });
      }

      // Verify the caller holds a valid Supabase session (admin is authenticated)
      const bearer = request.headers.get('Authorization');
      if (!bearer) return new Response('Unauthorized', { status: 401 });
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': bearer },
      });
      if (!userRes.ok) return new Response('Unauthorized', { status: 401 });

      const { family_id, parent_email, broadcast, title, body: msgBody } = await request.json().catch(() => ({}));
      if (!title) return new Response('Missing title', { status: 400 });

      // Resolve family_id from parent_email if needed
      let resolvedFamilyId = family_id;
      if (!broadcast && !resolvedFamilyId && parent_email) {
        // Validate the email before it goes into the PostgREST .or() filter.
        // encodeURIComponent does NOT escape * ( ) ! ~ ' so a value like "*"
        // would become ilike.* and match every family — reject those here.
        // Also reject literal `%`/`_`, the actual Postgres ILIKE wildcards, which
        // pass straight through independent of PostgREST's own `*` shorthand.
        if (typeof parent_email !== 'string' || !/^[^\s,()*%_@]+@[^\s,()*%_@]+\.[^\s,()*%_@]+$/.test(parent_email)) {
          return new Response('Invalid parent_email', { status: 400 });
        }
        const famRes = await fetch(
          `${SUPABASE_URL}/rest/v1/families?or=(parent_email.ilike.${encodeURIComponent(parent_email)},parent2_email.ilike.${encodeURIComponent(parent_email)})&select=id&limit=1`,
          { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        if (famRes.ok) {
          const fams = await famRes.json();
          if (fams.length) resolvedFamilyId = fams[0].id;
        }
      }

      // Fetch matching subscriptions
      let query = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`;
      if (!broadcast && resolvedFamilyId) query += `&family_id=eq.${encodeURIComponent(resolvedFamilyId)}`;

      const subsRes = await fetch(query, {
        headers: {
          'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!subsRes.ok) return new Response('Failed to fetch subscriptions', { status: 500 });

      const subs = await subsRes.json();
      if (!subs.length) return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });

      const results = await Promise.allSettled(
        subs.map(sub => sendWebPush(sub, { title, body: msgBody }, env))
      );

      // Remove expired (410 Gone) subscriptions
      const expired = subs
        .filter((_, i) => results[i].status === 'fulfilled' && results[i].value.status === 410)
        .map(s => s.id);
      if (expired.length) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/push_subscriptions?id=in.(${expired.join(',')})`,
          {
            method:  'DELETE',
            headers: {
              'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
      }

      const sent = subs.length - expired.length;
      return new Response(JSON.stringify({ sent }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Redirect .html URLs to clean URLs — Cloudflare Assets enforces clean URLs,
    // so /lookup.html, /admin.html, etc. must redirect to /lookup, /admin, etc.
    // Exclude /index.html which is handled separately by _redirects.
    if (url.pathname.endsWith('.html') && url.pathname !== '/index.html') {
      const clean = new URL(request.url);
      clean.pathname = url.pathname.slice(0, -5);
      return Response.redirect(clean.href, 301);
    }

    // Rewrite /calendar → /calendar.html (avoids _redirects loop in Workers Assets)
    if (url.pathname === '/calendar') {
      const rewritten = new URL(request.url);
      rewritten.pathname = '/calendar.html';
      request = new Request(rewritten.toString(), request);
    }

    // Rewrite /enroll → /enroll.html
    if (url.pathname === '/enroll') {
      const rewritten = new URL(request.url);
      rewritten.pathname = '/enroll.html';
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
