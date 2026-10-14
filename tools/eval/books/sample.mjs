/** Stratified random sampling of book items: equal share per book, areas cycled in a seeded random order, seeded random items inside an area. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const ITEMS_FILE = 'datasets_sources/books/eval/items.jsonl';
export const SEEN_FILE = 'datasets_sources/books/eval/seen.jsonl';
const key = (seed, s) => createHash('sha256').update(`${seed}/${s}`).digest('hex');
const shuffled = (list, seed, f = x => x) => [...list].sort((a, b) => key(seed, f(a)).localeCompare(key(seed, f(b))));

export const loadItems = root => fs.readFileSync(path.join(root, ITEMS_FILE), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
export const loadSeen = root => { const f = path.join(root, SEEN_FILE); return new Set(fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []); };
export function markSeen(root, ids, run) {
  const f = path.join(root, SEEN_FILE);
  fs.appendFileSync(f, ids.map(id => JSON.stringify({id, run, at: new Date().toISOString()})).join('\n') + '\n');
}

/** `n` items: filters (`books`, `areas` substrings), no verbatim repeats, no seen items unless `includeSeen`. */
export function sampleItems(items, {n = 100, seed = 'books-1', books = null, areas = null, ids = null, seen = new Set(), includeSeen = false} = {}) {
  if (ids) return ids.map(id => items.find(i => i.id === id)).filter(Boolean);
  let pool = items.filter(i => !i.dup_of && (includeSeen || !seen.has(i.id)));
  if (books) pool = pool.filter(i => books.includes(i.book));
  if (areas) pool = pool.filter(i => areas.some(a => i.area.toLowerCase().includes(a.toLowerCase())));
  const byBook = new Map();
  for (const i of pool) (byBook.get(i.book) ?? byBook.set(i.book, []).get(i.book)).push(i);
  const names = shuffled([...byBook.keys()], seed);
  if (!names.length) return [];
  const quota = new Map(names.map((b, k) => [b, Math.floor(n / names.length) + (k < n % names.length ? 1 : 0)]));
  const picked = [];
  for (const b of names) {
    const byArea = new Map();
    for (const i of byBook.get(b)) (byArea.get(i.area) ?? byArea.set(i.area, []).get(i.area)).push(i);
    const queues = shuffled([...byArea.keys()], `${seed}/${b}`).map(a => shuffled(byArea.get(a), `${seed}/${b}/${a}`, i => i.id));
    let want = quota.get(b), k = 0, guard = 0;
    while (want > 0 && queues.some(q => q.length) && guard++ < 1e6) {
      const q = queues[k++ % queues.length];
      if (q.length) { picked.push(q.shift()); want--; }
    }
  }
  // A book with fewer items than its share leaves the remainder to the others (random fill).
  if (picked.length < n) {
    const have = new Set(picked.map(i => i.id));
    picked.push(...shuffled(pool.filter(i => !have.has(i.id)), `${seed}/fill`, i => i.id).slice(0, n - picked.length));
  }
  return shuffled(picked, `${seed}/order`, i => i.id);
}
