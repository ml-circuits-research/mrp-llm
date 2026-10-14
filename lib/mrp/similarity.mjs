/**
 * Lexical similarity of two English texts (DS025 "Reflex" and "Round-trip check"): lowercased letter/digit tokens, a short list of
 * English function words dropped, a light suffix stemmer, and the cosine of tf-idf vectors. The idf comes from the compared collection
 * (the FAQ questions) when one is given. It is a structural measure over normalized English; it interprets nothing.
 */
const STOP = new Set(('a an the is are was were be been being am of in on at to from by with for about into over under than and or but if so as ' +
  'it its this that these those there here please').split(' '));

/** Content tokens with light stemming. */
export function terms(text) {
  const words = String(text ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter(w => !STOP.has(w)).map(w => w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);
}

const vector = (tokens, idf) => {
  const v = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  for (const [t, n] of v) v.set(t, n * (idf ? idf.get(t) ?? idf.missing : 1));
  return v;
};
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (const [t, x] of a) { na += x * x; if (b.has(t)) dot += x * b.get(t); }
  for (const x of b.values()) nb += x * x;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Cosine similarity of two texts in [0, 1]. */
export function similarity(a, b) { return cosine(vector(terms(a)), vector(terms(b))); }

/**
 * Ranks `items` ({id, q, variants?}) by similarity to `text`, with idf over all questions: `[{id, score, matched}]`, best first; an item
 * scores as its best-matching question (`q` or one of its `variants`).
 */
export function rank(text, items) {
  const questions = items.flatMap(item => [item.q, ...(item.variants ?? [])].map(q => ({id: item.id, q})));
  const best = new Map();
  for (const r of rankQuestions(text, questions)) if (!best.has(r.id) || best.get(r.id).score < r.score) best.set(r.id, {id: r.id, score: r.score, matched: r.q});
  return [...best.values()].sort((x, y) => y.score - x.score);
}

function rankQuestions(text, items) {
  const docs = items.map(item => terms(item.q));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + (items.length + 1) / n)]));
  // A term no question has weighs like the rarest term: it counts against every question equally.
  idf.missing = Math.log(2 + items.length);
  const query = vector(terms(text), idf);
  return items.map((item, i) => ({id: item.id, q: item.q, score: Math.round(cosine(query, vector(docs[i], idf)) * 1000) / 1000}));
}
