#!/usr/bin/env node
/**
 * Dev / sealed-test split of parts 2 and 3 of eval/suites/linking-v1 (eval-linking-v2, AGENTS.md Direction 9).
 * Parts 2 and 3 were looked at while the M3 linker was tuned, so M3 numbers are on the full, partially seen set. From here on a form
 * (part x gold relation, or "ask") is split by a fixed-seed hash, about half to `dev` (tuned on freely) and half to `test` (sealed:
 * measured once at the end, never read while tuning). Every form with two or more rows has rows in both halves.
 *
 *   node tools/eval/linking/split.mjs        writes eval/suites/linking-v1/split.json (refuses to overwrite an existing split)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readJsonlShardedSync} from '../../../lib/jsonl-shards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SPLIT_FILE = path.join(ROOT, 'eval/suites/linking-v1/split.json');
export const SEED = 'linking-v1-split-2026-10-01';
const formOf = row => `part${row.part}:${row.gold.ask || row.gold.relation === 'ambiguous' ? 'ask' : row.gold.relation}`;
const hash = id => crypto.createHash('sha1').update(SEED + id).digest('hex');

export function loadSplit() { return fs.existsSync(SPLIT_FILE) ? JSON.parse(fs.readFileSync(SPLIT_FILE, 'utf8')) : null; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (fs.existsSync(SPLIT_FILE)) { console.error('split.json exists; the sealed split is never redone'); process.exit(1); }
  const rows = [2, 3].flatMap(p => readJsonlShardedSync(path.join(ROOT, `eval/suites/linking-v1/part${p}.jsonl`)));
  const forms = new Map();
  for (const row of rows) (forms.get(formOf(row)) ?? forms.set(formOf(row), []).get(formOf(row))).push(row);
  const assign = {};
  for (const [form, list] of forms) {
    list.sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
    // Alternate along the hash order: the first row goes to the half chosen by the form's own hash, so odd sizes balance out.
    const first = hash(form).charCodeAt(0) % 2 ? 'dev' : 'test';
    list.forEach((row, i) => { assign[row.id] = (i % 2 === 0) === (first === 'dev') ? 'dev' : 'test'; });
  }
  const count = half => Object.values(assign).filter(h => h === half).length;
  const out = {suite: 'linking-v1', parts: [2, 3], seed: SEED, created: new Date().toISOString(), rule: 'per form (part x gold relation or ask), fixed-seed hash order, alternating dev/test',
    note: 'M3 (eval-linking-v1) numbers are on the full set, which was partially seen while tuning; dev is tuned on freely, test is sealed and measured once at the end (eval-linking-v2).',
    forms: forms.size, dev: count('dev'), test: count('test'), assign};
  fs.writeFileSync(SPLIT_FILE, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({forms: out.forms, dev: out.dev, test: out.test}));
}
