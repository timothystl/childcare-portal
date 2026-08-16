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

// ════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE ROOM CARDS (home page "Classrooms & Rates")
// ════════════════════════════════════════════════════════════════════════════
// #roomInfoGrid shipped as an empty <div> that js/app.js filled from Supabase
// after load. Google does execute JavaScript, but on a deferred second pass it
// is not obliged to complete — so the ages, rates, capacities and ratios, which
// are exactly what a parent searches for, were the least reliably indexed
// content on the page. This renders them into the HTML before it leaves the
// edge; the client still re-renders afterward.
//
// It reads the LIVE settings rather than baking a snapshot at build time,
// because the two genuinely disagree: as of writing, the defaults below say the
// Goose Room is 30–36 months and the Owl Room is 36+, while the saved settings
// say 36–60 and 24–36. A build-time snapshot would have published the wrong
// ages and capacities to Google with no way to notice.
//
// ⚠️ ROOM_CAPACITY_NOUNS / getSortedRooms / buildPublicRoomCardsHtml / ROOMS
// below are byte-identical copies of js/supabase.js and js/app.js. A cross-file
// drift guard in js/tests/business-logic.test.js fails CI if they diverge —
// which is what makes the duplication safe. Edit both sides, or neither.

const ROOM_CAPACITY_NOUNS = { bear: 'infants', bee: 'toddlers' };

const _ESC_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => _ESC_HTML_MAP[c]);
}

function getSortedRooms(rooms = ROOMS) {
    return rooms
        .map((room, i) => ({ room, i }))
        .sort((a, b) => {
            const aMin = a.room.ageMinMonths;
            const bMin = b.room.ageMinMonths;
            if (aMin == null && bMin == null) return a.i - b.i;
            if (aMin == null) return 1;
            if (bMin == null) return -1;
            if (aMin !== bMin) return aMin - bMin;
            return a.i - b.i;
        })
        .map(({ room }) => room);
}

function buildPublicRoomCardsHtml(rooms) {
    return rooms.map(room => {
        const spaceIdx = room.label.indexOf(' ');
        const emoji    = spaceIdx === -1 ? room.label : room.label.slice(0, spaceIdx);
        const name     = spaceIdx === -1 ? room.label : room.label.slice(spaceIdx + 1);
        const noun     = ROOM_CAPACITY_NOUNS[room.id] || 'children';
        const halfDayRow = (room.fullDayOnly || room.halfDayRate == null)
            ? `<div class="room-rate-row room-rate-note">Full Day Only</div>`
            : `<div class="room-rate-row"><span>Half Day</span><strong>$${room.halfDayRate}</strong></div>`;
        return `<div class="room-card"><div class="room-header"><span class="room-emoji">${escHtml(emoji)}</span><div class="room-name">${escHtml(name)}</div><div class="room-ages">${escHtml(room.ages || '')}</div></div><div class="room-body"><div class="room-rate-row"><span>Full Day</span><strong>$${room.fullDayRate}</strong></div>${halfDayRow}<div class="room-capacity">Max ${room.capacity ?? '—'} ${noun} · 1:${room.staffRatio ?? '—'} ratio</div></div></div>`;
    }).join('');
}

// settings.value is a TEXT column even when it holds JSON, so a row can arrive
// as a JSON string or as an already-parsed object depending on the key. This is
// the T3 trap; do not assume a parsed object.
function ssrParseSetting(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

// Fetched once every 5 minutes per edge location rather than on every page view.
// Returns null on any failure, and every caller treats null as "serve the page
// exactly as it is today" — a Supabase outage must not take the marketing page
// down for a nice-to-have.
async function ssrFetchSettings(env, ctx) {
  const cacheKey = new Request('https://ssr.internal/room-settings-v1');
  const cache    = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) { try { return await hit.json(); } catch { /* fall through and refetch */ } }

  if (!env.SUPABASE_ANON_KEY) return null;
  const keys = 'room_rates,room_capacity,staff_ratios,registration_fee,new_family_fee';
  let res;
  try {
    res = await Promise.race([
      fetch(`${SUPABASE_URL}/rest/v1/settings?key=in.(${keys})&select=key,value`, {
        headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ssr settings timeout')), 2000)),
    ]);
  } catch { return null; }
  if (!res || !res.ok) return null;

  const body = await res.text();
  ctx?.waitUntil?.(cache.put(cacheKey, new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
  })));
  try { return JSON.parse(body); } catch { return null; }
}

// Mirrors loadRateSettings/loadCapacitySettings/loadRatioSettings in
// js/supabase.js: start from the defaults, overlay whatever admin has saved.
async function ssrRoomState(env, ctx) {
  const rows = await ssrFetchSettings(env, ctx);
  if (!Array.isArray(rows)) return null;

  const byKey = {};
  for (const row of rows) byKey[row.key] = ssrParseSetting(row.value);

  const rooms = ROOMS.map(r => ({ ...r }));
  const rates = byKey.room_rates, caps = byKey.room_capacity, ratios = byKey.staff_ratios;

  for (const room of rooms) {
    const r = rates && typeof rates === 'object' ? rates[room.id] : null;
    if (r) {
      if (r.fullDayRate  != null) room.fullDayRate  = r.fullDayRate;
      if (r.halfDayRate  != null) room.halfDayRate  = r.halfDayRate;
      if ('ageMinMonths' in r)    room.ageMinMonths = r.ageMinMonths;
      if ('ageMaxMonths' in r)    room.ageMaxMonths = r.ageMaxMonths;
      if (r.ages         != null) room.ages         = r.ages;
    }
    if (caps   && caps[room.id]   != null) room.capacity   = caps[room.id];
    if (ratios && ratios[room.id] != null) room.staffRatio = ratios[room.id];
  }

  const num = v => (typeof v === 'number' ? v : Number(v));
  return {
    rooms,
    regFee:       num(byKey.registration_fee),
    newFamilyFee: num(byKey.new_family_fee),
    summerRate:   rooms.find(r => r.id === 'summer')?.fullDayRate ?? null,
  };
}

// Mirrors renderFeeNotes() in js/app.js. Kept as prose rather than a guarded
// copy because that function writes to two elements via the DOM; the sentence
// it produces is what is reproduced here.
function ssrFeeNote(regFee, newFamilyFee) {
  const parts = [];
  if (Number.isFinite(newFamilyFee) && newFamilyFee > 0) parts.push(`a one-time new family fee of $${newFamilyFee.toFixed(2)}`);
  if (Number.isFinite(regFee)       && regFee       > 0) parts.push(`an annual supply fee of $${regFee.toFixed(2)} per child`);
  return parts.length ? `Registration includes ${parts.join(' and ')}.` : '';
}

async function ssrRenderHomePage(response, env, ctx) {
  let state = null;
  try { state = await ssrRoomState(env, ctx); } catch { state = null; }
  if (!state) return response;   // fail open — serve the page untouched

  const cardsHtml = buildPublicRoomCardsHtml(
    getSortedRooms(state.rooms).filter(r => r.id !== 'summer' && !r.hidden)
  );
  const feeNote = ssrFeeNote(state.regFee, state.newFamilyFee);

  return new HTMLRewriter()
    .on('#roomInfoGrid', { element(el) { el.setInnerContent(cardsHtml, { html: true }); } })
    .on('#regFeeNote',   { element(el) { el.setInnerContent(feeNote); } })
    .on('#summerDailyFeeNote', {
      element(el) {
        if (state.summerRate != null) el.setInnerContent(` (<strong>$${state.summerRate}/day</strong>)`, { html: true });
      },
    })
    .transform(response);
}

const ROOMS = [
    { id: 'bear',   label: '🐻 Bear Room',   ages: 'Birth – 12 months', ageMinMonths: 0,    capacity: 8,  status: 'active',   fullDayOnly: true,  fullDayRate: 80, halfDayRate: null, staffRatio: 4 },
    { id: 'bee',    label: '🐝 Bee Room',    ages: '12 – 24 months',    ageMinMonths: 12,   capacity: 16, status: 'active',   fullDayOnly: false, fullDayRate: 75, halfDayRate: 55,   staffRatio: 4 },
    { id: 'turtle', label: '🐢 Turtle Room', ages: '24 – 30 months',    ageMinMonths: 24,   capacity: 11, status: 'active',   fullDayOnly: false, fullDayRate: 75, halfDayRate: 45,   staffRatio: 8 },
    { id: 'goose',  label: '🪿 Goose Room',  ages: '30 – 36 months',    ageMinMonths: 30,   capacity: 12, status: 'active',   fullDayOnly: false, fullDayRate: 75, halfDayRate: 45,   staffRatio: 8 },
    { id: 'owl',    label: '🦉 Owl Room',    ages: '36+ months',        ageMinMonths: 36,   capacity: 11, status: 'active',   fullDayOnly: false, fullDayRate: 75, halfDayRate: 45,   staffRatio: 8 },
    { id: 'summer', label: '☀️ Summer Camp', ages: '4–9 years',         ageMinMonths: null, capacity: 25, status: 'seasonal', fullDayOnly: true,  fullDayRate: 75, halfDayRate: null, staffRatio: 11, hidden: false },
];

export default {
  async fetch(request, env, ctx) {
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
    // Two ways in, because two logins exist:
    //
    //   1. A real Supabase session (the parent portal, Option B). The family is
    //      DERIVED from the token via parent_accounts — the caller does not get
    //      to say which family they are subscribing, which the old path allowed
    //      as long as the id matched the token.
    //   2. The legacy HMAC family token (calendar.html). Still needed: that page
    //      now ADOPTS a portal session when one exists and sends the access
    //      token down path 1, but its email + PIN form is the only way in for a
    //      parent who never opened the portal, and that path has no session to
    //      send. This branch goes away when email + PIN itself does.
    if (url.pathname === '/push-subscribe' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { endpoint, p256dh, auth } = body;
      if (!endpoint || !p256dh || !auth) {
        return new Response('Missing fields', { status: 400 });
      }

      const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!bearer) return new Response('Unauthorized', { status: 401 });

      let family_id = null;

      // Ask Supabase to validate the token rather than verifying it here. The
      // project signs with asymmetric keys now, so local verification would mean
      // fetching and caching a JWKS — and getting that subtly wrong fails open.
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': env.SUPABASE_ANON_KEY ?? '', 'Authorization': `Bearer ${bearer}` },
      });
      if (userRes.ok) {
        const user = await userRes.json().catch(() => null);
        if (user?.id) {
          const paRes = await fetch(
            `${SUPABASE_URL}/rest/v1/parent_accounts?user_id=eq.${encodeURIComponent(user.id)}&select=family_id&limit=1`,
            { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
          );
          if (paRes.ok) {
            const rows = await paRes.json().catch(() => []);
            if (rows.length) family_id = rows[0].family_id;
          }
        }
      }

      // Legacy path: the caller supplies the family id and the HMAC proves it.
      if (!family_id && body.family_id) {
        const ok = await verifyFamilyToken(bearer, env.FAMILY_SESSION_SECRET ?? '', body.family_id);
        if (ok) family_id = body.family_id;
      }

      if (!family_id) return new Response('Unauthorized', { status: 401 });

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
      // ⚠️ This had NO authentication at all: the caller named a staff_id and
      // the subscription was written. Anyone could have registered their own
      // device to receive another staff member's notifications, or filled the
      // table. The PIN is the credential staff have, so it is the credential
      // used — and staff_id is DERIVED from it, never taken from the body.
      const { staff_id: claimedStaffId, pin, endpoint, p256dh, auth } = await request.json().catch(() => ({}));
      if (!claimedStaffId || !pin || !endpoint || !p256dh || !auth) {
        return new Response('Missing fields', { status: 400 });
      }
      if (!/^\d{4,8}$/.test(String(pin))) return new Response('Unauthorized', { status: 401 });

      const pinRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/staff_id_for_pin`, {
        method: 'POST',
        headers: {
          'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
        },
        // Named account + PIN. The pin-only signature is dropped — it tested a
        // guess against every staff hash and left no account to lock.
        body: JSON.stringify({ p_staff_id: claimedStaffId, p_pin: parseInt(String(pin), 10) }),
      });
      if (!pinRes.ok) return new Response('Unauthorized', { status: 401 });
      const staff_id = await pinRes.json().catch(() => null);
      if (!staff_id) return new Response('Unauthorized', { status: 401 });

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

    // ── POST /send-staff-broadcast — every staff phone at once ───────────────
    // The missing-child alert. /send-staff-push next door sends to ONE staff_id
    // and demands the service role key, so neither half of it fits: this has to
    // reach everybody, and it is triggered from a teacher's phone, which holds
    // the public anon key and a PIN and must never hold the service role key.
    //
    // ⚠️ THE CLIENT SENDS AN ALERT ID, NEVER A MESSAGE. No title, no body, no
    // recipient — the worker reads the alert with the service role and composes
    // the text itself. This is the send-invoice posture, and it is the whole
    // reason T1/FS6/FS11 do not apply here: there is no field in this request
    // that can aim a notification at anybody or put words in it.
    //
    // ⚠️ NOT ADMIN-GATED, DELIBERATELY. The person who discovers a child is
    // missing is a teacher on the floor, not the director at a desk. Requiring
    // an admin session would mean the alert waits for the office, which is
    // exactly what the handoff says it must not do.
    if (url.pathname === '/send-staff-broadcast' && request.method === 'POST') {
      const reqOrigin = request.headers.get('Origin');
      if (reqOrigin && !ALLOWED_ORIGINS.has(reqOrigin)) {
        return new Response('Forbidden', { status: 403 });
      }

      const { staff_id: claimedStaffId, pin, kind, alert_id } = await request.json().catch(() => ({}));
      if (!claimedStaffId || !pin || !alert_id) return new Response('Missing fields', { status: 400 });
      if (!/^\d{4,8}$/.test(String(pin))) return new Response('Unauthorized', { status: 401 });
      if (kind !== 'missing_child' && kind !== 'missing_child_cleared') {
        return new Response('Unknown kind', { status: 400 });
      }

      // Same credential check as /staff-push-subscribe: named account plus PIN,
      // resolved server-side. A PIN alone was dropped everywhere else in this
      // app because it tested a guess against every staff hash.
      const pinRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/staff_id_for_pin`, {
        method: 'POST',
        headers: {
          'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ p_staff_id: claimedStaffId, p_pin: parseInt(String(pin), 10) }),
      });
      if (!pinRes.ok) return new Response('Unauthorized', { status: 401 });
      const callerStaffId = await pinRes.json().catch(() => null);
      if (!callerStaffId) return new Response('Unauthorized', { status: 401 });

      // Read the alert. Everything the notification says comes from this row.
      const alertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/missing_child_alerts?id=eq.${encodeURIComponent(alert_id)}&select=id,child_name,room_id,wearing,last_seen,status&limit=1`,
        { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (!alertRes.ok) return new Response('Failed to read alert', { status: 500 });
      const [alert] = await alertRes.json();
      if (!alert) return new Response('No such alert', { status: 404 });

      // The message. Deliberately NOT the no-detail wording used for incident
      // notices: that one protects a child's privacy on a lock screen read in
      // public, and this one is read by staff who need the description to
      // search. Different audience, opposite requirement.
      const cleared = kind === 'missing_child_cleared' || alert.status === 'found';
      const payload = cleared
        ? {
            title: `✅ Found — ${alert.child_name}`,
            body:  'All clear. Stop searching and go back to your room.',
            tag:   `missing-${alert.id}`,
          }
        : {
            title: `🚨 MISSING CHILD — ${alert.child_name}`,
            body:  [
              alert.room_id ? `Room: ${alert.room_id}` : '',
              alert.wearing ? `Wearing ${alert.wearing}` : '',
              alert.last_seen ? `Last seen ${alert.last_seen}` : '',
              'Open the app and search.',
            ].filter(Boolean).join(' · '),
            tag:   `missing-${alert.id}`,
          };

      const subsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staff_push_subscriptions?select=*`,
        { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (!subsRes.ok) return new Response('Failed to fetch subscriptions', { status: 500 });
      const subs = await subsRes.json();
      if (!subs.length) return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });

      const results = await Promise.allSettled(subs.map(sub => sendWebPush(sub, payload, env)));

      const expired = subs
        .filter((_, i) => results[i].status === 'fulfilled' && results[i].value.status === 410)
        .map(s => s.id);
      if (expired.length) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/staff_push_subscriptions?id=in.(${expired.join(',')})`,
          { method: 'DELETE', headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
      }

      return new Response(JSON.stringify({ sent: subs.length - expired.length }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
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

      // ⚠️ "Holds a valid session" USED to mean "is an admin", because admins
      // were the only people with Supabase accounts. Option B gave every parent
      // a real session, so that check stopped meaning anything: any of ~242
      // parents could have sent an arbitrary notification to any family, or
      // broadcast one to all 121. Ask the database whether they are an admin.
      const bearer = request.headers.get('Authorization');
      if (!bearer) return new Response('Unauthorized', { status: 401 });

      // Scheduled senders (the end-of-day summary, the photo notification) run
      // as the service role and have no admin user to speak for. Same escape
      // hatch /send-staff-push already uses. The key never reaches a browser.
      const rawBearer = bearer.replace(/^Bearer\s+/i, '');
      const isService = env.SUPABASE_SERVICE_ROLE_KEY && rawBearer === env.SUPABASE_SERVICE_ROLE_KEY;

      if (!isService) {
      const adminRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_admin`, {
        method: 'POST',
        headers: {
          'apikey':        env.SUPABASE_ANON_KEY ?? '',
          'Authorization': bearer,           // the CALLER's token, so is_admin() sees their email
          'Content-Type':  'application/json',
        },
        body: '{}',
      });
      if (!adminRes.ok) return new Response('Unauthorized', { status: 401 });
      const isAdmin = await adminRes.json().catch(() => false);
      if (isAdmin !== true) return new Response('Forbidden', { status: 403 });
      }

      const reqJson = await request.json().catch(() => ({}));
      let { family_id, parent_email, broadcast, title, body: msgBody } = reqJson;

      // ── Reference mode ──────────────────────────────────────
      // `{ announcement_id }` instead of `{ broadcast, title, body }`. The
      // worker reads the row with the service role and composes the text, so
      // what parents receive is what is actually stored and readable in the
      // portal — the two cannot drift, and no wording travels from a browser.
      // The older free-text shape still works for the call sites that predate
      // this; new senders should reference a row.
      if (reqJson.announcement_id) {
        const annRes = await fetch(
          `${SUPABASE_URL}/rest/v1/announcements?id=eq.${encodeURIComponent(reqJson.announcement_id)}&select=id,title,body,kind,published_at&limit=1`,
          { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        if (!annRes.ok) return new Response('Failed to read announcement', { status: 500 });
        const [ann] = await annRes.json();
        if (!ann) return new Response('No such announcement', { status: 404 });
        // A draft is not readable in the portal, so pushing one would send
        // parents to a page that shows them nothing.
        if (!ann.published_at) return new Response('Announcement is a draft', { status: 400 });

        broadcast = true;
        family_id = null; parent_email = null;
        title   = ann.kind === 'closure' ? `🚨 ${ann.title}` : ann.title;
        // Trimmed: a lock screen shows two lines, and the portal has the rest.
        msgBody = String(ann.body || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      }

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
      // R25: style-src/font-src previously omitted the Google Fonts hosts that
      // every page links (Lora, Nunito, Dancing Script), and the brand
      // typography fell back to Georgia / system-ui in production.
      //
      // ⚠️ This block previously claimed the header here "overrides _headers".
      // That is wrong for any path backed by a real file: Workers Assets serves
      // those without running this script at all, so `_headers` is what actually
      // applied. Only paths listed in `run_worker_first` (wrangler.jsonc) plus
      // paths with no matching file reach this code. `_headers` remains the
      // effective policy for everything else — so the two MUST stay in sync,
      // and a change made only here will silently do nothing.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net https://cloudflareinsights.com; " +
      "img-src 'self' data:; " +
      // frame-src for the Google Maps embed on the home page contact section.
      // There is no frame-src default: without this it falls back to
      // `default-src 'self'` and the map renders as an empty box with only a
      // console error to say why — the same silent-failure shape as R25 above.
      // Both hosts are needed: the /maps?output=embed URL is served by
      // maps.google.com and redirects to www.google.com/maps/embed.
      "frame-src https://maps.google.com https://www.google.com; " +
      "font-src 'self' data: https://fonts.gstatic.com"
    );
    // Cache-Control (R9). Previously every asset was `no-store`, so each page
    // view re-downloaded the whole stack — dist/admin.min.js alone is ~600 KB.
    //
    // The bundle filenames are NOT content-hashed (the HTML references
    // dist/admin.min.js literally, and the deploy has no build step), so they
    // must never be cached immutably — a deploy would keep serving stale JS.
    // `no-cache` is the correct middle ground: the browser still revalidates on
    // every request, but a matching ETag returns an empty 304 instead of the
    // full body. Correctness is identical to `no-store`; the bytes are not.
    //
    // Truly immutable media (images, fonts, favicon) is content-stable and can
    // be cached hard. HTML stays `no-store` so a deploy is picked up instantly.
    const p = url.pathname;
    if (/\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)$/i.test(p)) {
      newHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/^\/(dist|css|img|images)\//i.test(p) || p === '/manifest.json') {
      newHeaders.set('Cache-Control', 'no-cache');
    } else {
      newHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }

    // Ensure service worker can claim full scope
    if (url.pathname === '/sw.js') {
      newHeaders.set('Service-Worker-Allowed', '/');
    }

    const out = new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers:    newHeaders,
    });

    // Server-render the classroom cards into the home page — see SERVER-SIDE
    // ROOM CARDS at the top of this file. Home page only, 200 only: an error
    // page has no #roomInfoGrid to fill and would just pay for a settings
    // fetch. ssrRenderHomePage fails open, returning `out` untouched.
    if ((p === '/' || p === '/index.html') && out.status === 200) {
      return ssrRenderHomePage(out, env, ctx);
    }

    return out;
  },
};
