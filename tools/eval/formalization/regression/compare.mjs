#!/usr/bin/env node
/**
 * Paired comparison of two runs on the same cases (eval-semantic-decomposition-v1): correct counts per run and per stratum (the book of
 * a book problem, the source of a chat case), the paired difference with a bootstrap interval (seeded, 10000 resamples), and the
 * cases fixed and lost.   node tools/eval/formalization/regression/compare.mjs RUN_A RUN_B [--seed s]
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {STATE} from './cases.mjs';

const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const strat = id => id.startsWith('books/') ? id.slice(6).split(':')[0] : id.split('/')[0];

/** A seeded uniform generator (sha256 counter). */
function rng(seed) {
  let n = 0;
  return () => parseInt(createHash('sha256').update(`${seed}/${n++}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
}

export function compare(runA, runB, {seed = 'paired', resamples = 10000} = {}) {
  const a = new Map(readJsonl(path.join(STATE, runA, 'results.jsonl')).map(r => [r.id, r])), b = new Map(readJsonl(path.join(STATE, runB, 'results.jsonl')).map(r => [r.id, r]));
  const ids = [...a.keys()].filter(id => b.has(id));
  const ok = r => (r?.outcome === 'correct' ? 1 : 0);
  const d = ids.map(id => ok(a.get(id)) - ok(b.get(id)));
  const rand = rng(seed), means = [];
  for (let k = 0; k < resamples; k++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]; means.push(s / d.length); }
  means.sort((x, y) => x - y);
  const strata = {};
  for (const id of ids) { const s = strata[strat(id)] ??= {n: 0, [runA]: 0, [runB]: 0}; s.n++; s[runA] += ok(a.get(id)); s[runB] += ok(b.get(id)); }
  const outcomes = run => Object.fromEntries(['correct', 'wrong', 'unknown', 'invalid', 'failed', 'pending'].map(o => [o, ids.filter(id => run.get(id).outcome === o).length]));
  return {cases: ids.length, [runA]: outcomes(a), [runB]: outcomes(b), diff: d.reduce((x, y) => x + y, 0) / (d.length || 1), ci95: [means[Math.floor(0.025 * resamples)], means[Math.floor(0.975 * resamples)]],
    strata, fixed: ids.filter(id => ok(a.get(id)) && !ok(b.get(id))), lost: ids.filter(id => !ok(a.get(id)) && ok(b.get(id)))};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [ra, rb] = process.argv.slice(2);
  const i = process.argv.indexOf('--seed');
  console.log(JSON.stringify(compare(ra, rb, {seed: i >= 0 ? process.argv[i + 1] : 'paired'}), null, 1));
}
