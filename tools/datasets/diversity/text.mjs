/** Text utilities shared by the source miner, the generator and its self-metrics. No source text is stored. */

export const words = text => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
export const foldDiacritics = text => String(text).normalize('NFKD').replace(/\p{M}+/gu, '');

/** English and Romanian closed-class words kept by the structural masker; everything else becomes X. */
export const FUNCTION_WORDS = new Set((
  'a an the this that these those some any every each all both either neither no none not nor never only also just even ' +
  'i me my mine we us our you your yours he him his she her it its they them their one someone something anyone anything everyone everybody somebody nobody nothing ' +
  'who whom whose what which where when why how whether if then than else because since until while although though unless so as ' +
  'is are was were be been being am do does did done doing have has had having can could shall should will would may might must ' +
  "don't doesn't didn't isn't aren't wasn't weren't can't couldn't won't wouldn't shouldn't haven't hasn't i'm i've you're it's " +
  'of in on at to for from by with without about into onto over under after before during between among through against up down out off ' +
  'and or but yet there here more most less least many much few several other another same such very too quite really best better way ' +
  'there\'s let let\'s please get got make made go going know think want need like say said tell ' +
  // Romanian function words, with and without diacritics.
  'și si sau dar iar ci nici nu da un o unui unei niște niste cel cea cei cele lui lor ei el ea ele ei eu tu noi voi mă ma te se ne vă va îi ii le li ' +
  'ce cine care cât cat câți cati câte cate când cand unde cum de ce dacă daca că ca să sa la în in pe cu din spre prin pentru pt fără fara despre după dupa până pana ' +
  'este e sunt era erau a au am ai are fost fi fie poate pot putea trebuie vreau vrea mai foarte doar tot toți toti toate toată toata oare cumva'
).split(/\s+/).filter(Boolean));

/** Structural skeleton: closed-class words kept, content words masked, runs of X collapsed. */
export function maskStructure(text, { keepPunctuation = true } = {}) {
  const parts = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?|[?!.,;:]/gu) ?? [];
  const out = [];
  for (const part of parts) {
    const token = /^[?!.,;:]$/.test(part) ? (keepPunctuation ? part : null)
      : /^\d+$/.test(part) ? 'N' : FUNCTION_WORDS.has(part) ? part : 'X';
    if (token === null) continue;
    if ((token === 'X' || token === 'N') && out.at(-1) === token) continue;
    out.push(token);
  }
  return out.join(' ');
}

export function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], previous[j - 2] + 1);
      best = Math.min(best, current[j]);
    }
    if (best > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length];
}

export const multiset = list => list.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map());
/** Multiset difference a − b as a list. */
export function minus(a, b) {
  const counts = multiset(b), out = [];
  for (const item of a) {
    const n = counts.get(item) ?? 0;
    if (n > 0) counts.set(item, n - 1);
    else out.push(item);
  }
  return out;
}
export const jaccard = (a, b) => {
  const x = new Set(a), y = new Set(b);
  const inter = [...x].filter(item => y.has(item)).length;
  return inter / Math.max(1, new Set([...x, ...y]).size);
};

/** Increment a tally object. */
export const bump = (tally, key, by = 1) => { tally[key] = (tally[key] ?? 0) + by; return tally; };
export const sortTally = (tally, limit = Infinity) => Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit));

/** Deterministic 32-bit hash and seeded PRNG (mulberry32). */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (const char of String(text)) h = Math.imul(h ^ char.codePointAt(0), 0x01000193) >>> 0;
  return h >>> 0;
}
export function rng(seed) {
  let a = hash32(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const api = {
    next,
    int: n => Math.floor(next() * n),
    pick: list => list[Math.floor(next() * list.length)],
    chance: p => next() < p,
    shuffle: list => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; },
    sample: (list, k) => api.shuffle(list).slice(0, k),
    weighted: entries => {
      const total = entries.reduce((n, [, w]) => n + w, 0);
      let r = next() * total;
      for (const [value, weight] of entries) { r -= weight; if (r <= 0) return value; }
      return entries.at(-1)[0];
    },
  };
  return api;
}

export const capitalize = text => text ? text[0].toUpperCase() + text.slice(1) : text;
