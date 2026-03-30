#!/usr/bin/env node
// One-time VAPID key generation for Web Push notifications.
// Run: node scripts/generate-vapid-keys.js
// Then follow the printed instructions to add secrets to Cloudflare.

const { webcrypto } = require('crypto');

async function main() {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicRaw  = await webcrypto.subtle.exportKey('raw',  keyPair.publicKey);
  const publicB64  = Buffer.from(publicRaw).toString('base64url');

  console.log('\n=== VAPID Keys Generated ===\n');
  console.log('VAPID_PUBLIC_KEY (paste into js/push-notifications.js):');
  console.log(publicB64);

  console.log('\n--- Add these as Cloudflare Worker secrets ---');
  console.log('Run each command and paste the value when prompted:\n');
  console.log('1.  npx wrangler secret put VAPID_PRIVATE_KEY');
  console.log('    Value:', JSON.stringify(privateJwk));
  console.log('\n2.  npx wrangler secret put VAPID_PUBLIC_KEY');
  console.log('    Value:', publicB64);
  console.log('\n3.  npx wrangler secret put VAPID_SUBJECT');
  console.log('    Value: mailto:admin@timothystl.org');
  console.log('\n4.  npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY');
  console.log('    Value: (Supabase dashboard → Settings → API → service_role key)');
  console.log('\nKeep these values private — never commit them to the repo.');
}

main().catch(err => { console.error(err); process.exit(1); });
