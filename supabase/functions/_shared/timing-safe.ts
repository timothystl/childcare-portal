// Constant-time string comparison for secrets (API keys, cron secrets, webhook tokens).
// Hashes both inputs to fixed-length SHA-256 digests first, so unequal-length inputs never
// short-circuit into a faster comparison path the way a plain `a.length !== b.length` early
// return would -- comparison time depends only on the (constant) digest length, not on the
// caller-supplied secret's length.
export async function safeEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = av.length ^ bv.length;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}
