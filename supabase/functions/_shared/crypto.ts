/**
 * Constant-time string comparison for shared-secret headers (webhook
 * signatures, cron delivery secrets). A plain `a === b` short-circuits on the
 * first mismatched byte, which leaks how many leading characters a guess got
 * right through response timing -- this always walks the full length instead.
 */
export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
