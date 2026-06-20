/**
 * Randomness that is safe to hand to a stranger.
 *
 * `Math.random()` is a fast, seeded PRNG (xorshift128+ in V8). It is not a secret
 * generator: a few consecutive outputs are enough to recover the internal state and
 * predict every subsequent value. That is fine for jitter or a shuffle and wrong for
 * anything an outsider would like to guess — which, in this bot, meant the `subId`
 * that *is* a customer's subscription URL.
 *
 * Workers expose the WebCrypto global unconditionally, so there is no environment in
 * which this module needs a fallback: `crypto.getRandomValues` is available in the
 * Worker runtime, in `wrangler dev`, and under the local Node long-poller (`poll.ts`,
 * Node 18+ exposes it globally too).
 *
 * Both helpers use rejection sampling rather than a bare `%`. Taking `value % n` from
 * a uniform range that is not a multiple of `n` makes the first few outcomes slightly
 * more likely than the rest; discarding the short tail of the range costs one extra
 * draw with vanishing probability and removes the bias entirely.
 */

/** Lowercase alphanumerics — the shape 3X-UI subIds and passwords have always had. */
export const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Decimal digits, for human-readable suffixes. */
export const DIGITS = "0123456789";

const UINT32_RANGE = 0x1_0000_0000;

/**
 * Uniformly random integer in `[0, max)`.
 *
 * Throws on a non-positive or non-integer `max` instead of quietly returning `NaN`
 * or `0`, because every caller here uses the result to pick from a fixed set and a
 * silent `0` would look like a working coin that always lands heads.
 */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max < 1 || max > UINT32_RANGE) {
    throw new RangeError(`randomInt: max must be an integer in [1, 2^32], got ${max}`);
  }
  if (max === 1) return 0;

  const limit = Math.floor(UINT32_RANGE / max) * max;
  const buf = new Uint32Array(1);

  // Terminates with probability 1: at most (max - 1) of 2^32 values are rejected, so
  // for every `max` used here the first draw is accepted virtually always.
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/**
 * Random string of exactly `length` characters drawn uniformly from `alphabet`.
 *
 * Note "exactly": the `Math.random().toString(36).substring(2, 2 + n)` idiom this
 * replaced silently produced *fewer* than `n` characters, because a double's base-36
 * expansion runs out at around 11 digits. Callers asking for 16 were getting 11 or
 * so, from a predictable source.
 */
export function randomToken(length: number, alphabet: string = LOWER_ALNUM): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`randomToken: length must be a positive integer, got ${length}`);
  }
  if (alphabet.length < 2 || alphabet.length > 256) {
    throw new RangeError(`randomToken: alphabet must hold 2..256 characters, got ${alphabet.length}`);
  }

  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const buf = new Uint8Array(length);
  let out = "";

  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= limit) continue; // rejected — keeps every character equally likely
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }

  return out;
}
