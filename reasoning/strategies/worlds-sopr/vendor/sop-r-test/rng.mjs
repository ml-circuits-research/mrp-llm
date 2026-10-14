// VENDORED: the deterministic PRNG of sop-r.zip test/difftest.mjs (lines 69-74), copied verbatim
// deterministic PRNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, choice: (xs) => xs[Math.floor(next() * xs.length)], sample: (xs, k) => { const c = xs.slice(), o = []; while (o.length < k) o.push(c.splice(Math.floor(next() * c.length), 1)[0]); return o; } };
}
