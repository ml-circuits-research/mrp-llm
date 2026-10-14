/**
 * `order random` (DS004 "Sampling", DS014 "Words, not operators"): the answers of a `mode select` query in a seeded random order, cut by `limit`, which makes
 * a random sample ("a random fact", "give me some examples"). The answer set is computed first and is the set without the option; only
 * its order and the cut change. The seed comes from the request (the turn time or an explicit seed), so the same seed gives the same
 * sample and a test can fix it.
 */

/** FNV-1a over the text of the seed: any number or string becomes a 32-bit PRNG state. */
function seedState(seed) {
  let h = 0x811c9dc5;
  for (const c of String(seed)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** mulberry32: a small, well-mixed 32-bit generator; returns floats in [0, 1). */
function generator(seed) {
  let a = seedState(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy (Fisher-Yates) of `items`, determined by `seed`. */
export function shuffled(items, seed) {
  const out = [...items], next = generator(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The sample of `items`: shuffled by `seed`, then the first `limit`.
 * @returns {items, truncated, sample: {order: 'random', limit, of, seed}} where `of` is the size of the full answer set and `limit`
 *   is null when the query set none (a random order of every answer)
 */
export function sampleAnswers(items, {limit = Infinity, seed}) {
  const all = shuffled(items, seed);
  const cut = Number.isFinite(limit) ? all.slice(0, limit) : all;
  return {items: cut, truncated: cut.length < all.length, sample: {order: 'random', limit: Number.isFinite(limit) ? limit : null, of: all.length, seed}};
}
