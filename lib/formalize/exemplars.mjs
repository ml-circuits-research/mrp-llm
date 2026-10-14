/**
 * Verified-exemplar retrieval for the expression path (experiments/proposal/formalization-research-directions.md, variant F1): programs
 * that agreed with an independent formalization and matched the gold are indexed by the SHAPE of their registry, and the two nearest
 * are shown in the prompt of a new problem as their numbers and program lines only (the exemplar's problem text is book-derived and
 * never shown, DS011). The shape is structure: how many numbers, how many are percentages, how many are decimals, the magnitude
 * profile. Leave-one-out is the caller's: `exclude(id)` drops the problem itself and its content-word duplicates.
 */

import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

/** The local exemplar index (book-derived numbers, so it lives in the gitignored datasets_sources/, DS011); [] when absent. */
export const EXEMPLAR_INDEX = fileURLToPath(new URL('../../datasets_sources/formalization-regression/exemplars/index.jsonl', import.meta.url));
let cached = null;
export function loadExemplarIndex(file = EXEMPLAR_INDEX) {
  if (cached?.file === file) return cached.rows;
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  cached = {file, rows};
  return rows;
}

/** The shape of a registry: counts and a coarse magnitude profile. */
export function shapeOf(registry) {
  const n = registry.length, pct = registry.filter(v => v.percent).length, dec = registry.filter(v => !Number.isInteger(v.value)).length;
  const mags = registry.map(v => Math.max(0, Math.min(5, Math.floor(Math.log10(Math.abs(v.value) || 1)))));
  return {n, pct, dec, mags};
}

/** Distance between two shapes (smaller is closer): number count first, then percentages, decimals and magnitudes in order. */
export function shapeDistance(a, b) {
  let d = 2 * Math.abs(a.n - b.n) + 3 * Math.abs(a.pct - b.pct) + Math.abs(a.dec - b.dec);
  const m = Math.max(a.mags.length, b.mags.length);
  for (let i = 0; i < m; i++) d += 0.25 * Math.abs((a.mags[i] ?? 0) - (b.mags[i] ?? 0));
  return d;
}

/** An exemplar row: {id, shape, numbers (the `vK = span` lines), program (the accepted lines), meta}. */
export function exemplarOf({id, registry, program, meta = {}}) {
  return {id, shape: shapeOf(registry), numbers: registry.map(v => `v${v.index} = ${v.span}`).join(', '), program, meta};
}

/** The `k` nearest exemplars to a registry, skipping those `exclude(row)` rejects; ties by id for determinism. */
export function retrieve(index, registry, {k = 2, exclude = () => false} = {}) {
  const shape = shapeOf(registry);
  return index.filter(r => !exclude(r)).map(r => ({r, d: shapeDistance(shape, r.shape)}))
    .sort((x, y) => x.d - y.d || String(x.r.id).localeCompare(String(y.r.id))).slice(0, k).map(x => x.r);
}
