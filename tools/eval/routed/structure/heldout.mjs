#!/usr/bin/env node
/**
 * The strict held-out split of train-psm-lfm-v1 (status/preregistrations/train-psm-lfm-v1.json): 20% of the section units of each book,
 * chosen by sha256("train-psm-lfm-v1/<unit>"), frozen before any teacher data is generated (D1). A unit is a book section; in the
 * math book, where every problem is its own numbered section ("<title> 1", "<title> 2"), the unit is the title without its number,
 * so near-copies of a held-out problem are held out too. Held-out items are never sampled for data generation or training; they are
 * the E1 test set. The frozen list lives with the book data (local, DS011): datasets_sources/books/eval/heldout-train-psm-lfm-v1.json.
 *
 *   node tools/eval/routed/structure/heldout.mjs freeze     writes the list once (refuses to overwrite)
 *   node tools/eval/routed/structure/heldout.mjs check      recomputes and compares (exit 1 on a mismatch)
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadItems} from '../../books/sample.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const SEED = 'train-psm-lfm-v1';
export const FRACTION = 0.2;
export const HELDOUT_FILE = path.join(ROOT, 'datasets_sources/books/eval/heldout-train-psm-lfm-v1.json');

export const unitOf = item => `${item.book}/${String(item.section ?? '').replace(/\s+\d+$/, '').trim()}`;
const rank = unit => createHash('sha256').update(`${SEED}/${unit}`).digest('hex');

/** The held-out units: per book, the first round(FRACTION × units) in hash order. */
export function computeHeldout(items) {
  const byBook = new Map();
  for (const i of items) { if (!byBook.has(i.book)) byBook.set(i.book, new Set()); byBook.get(i.book).add(unitOf(i)); }
  const units = [];
  for (const [, set] of [...byBook].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...set].sort((a, b) => rank(a).localeCompare(rank(b)));
    units.push(...sorted.slice(0, Math.max(1, Math.round(FRACTION * sorted.length))));
  }
  return units.sort();
}

/** The frozen held-out units (throws when the list was never frozen). */
export function heldoutUnits() {
  if (!fs.existsSync(HELDOUT_FILE)) throw new Error(`no frozen held-out list: run node tools/eval/routed/structure/heldout.mjs freeze (${HELDOUT_FILE})`);
  return new Set(JSON.parse(fs.readFileSync(HELDOUT_FILE, 'utf8')).units);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const items = loadItems(ROOT);
  const units = computeHeldout(items);
  const sha = createHash('sha256').update(units.join('\n')).digest('hex');
  const cmd = process.argv[2];
  if (cmd === 'freeze') {
    if (fs.existsSync(HELDOUT_FILE)) { console.error(`already frozen: ${HELDOUT_FILE}`); process.exit(1); }
    const n = items.filter(i => units.includes(unitOf(i))).length;
    fs.writeFileSync(HELDOUT_FILE, JSON.stringify({seed: SEED, fraction: FRACTION, frozen_at: new Date().toISOString(), sha256: sha, items: n, units}, null, 1) + '\n');
    console.log(`froze ${units.length} units (${n} items), sha256 ${sha}`);
  } else if (cmd === 'check') {
    const f = JSON.parse(fs.readFileSync(HELDOUT_FILE, 'utf8'));
    const ok = f.sha256 === sha;
    console.log(ok ? `ok: ${units.length} units, sha256 ${sha}` : `MISMATCH: frozen ${f.sha256}, recomputed ${sha}`);
    process.exit(ok ? 0 : 1);
  } else { console.error('usage: heldout.mjs freeze|check'); process.exit(2); }
}
