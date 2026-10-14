#!/usr/bin/env node
/**
 * A stratified sample of fresh book problems for an evaluation (first used by eval-semantic-decomposition-v1): per book `n` problems with at least `minNumbers`
 * numbers in the question (structure), never a problem of the regression set or one run before (datasets_sources/books/eval/seen.jsonl).
 *   node tools/eval/formalization/regression/sample-stage.mjs --books commonsense,decompose,adult,world,math --n 10 --seed s --out FILE
 */
import fs from 'node:fs';
import {loadItems, loadSeen, sampleItems} from '../../books/sample.mjs';
import {loadCases, ROOT} from './cases.mjs';
import {extractNumbers} from '../../../../lib/formalize/registry.mjs';

const opt = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const books = opt('--books', 'commonsense,decompose,adult,world,math').split(','), n = Number(opt('--n', 10)), min = Number(opt('--min-numbers', 2));
const taken = new Set([...loadSeen(ROOT), ...loadCases().map(c => c.provenance?.problem_id).filter(Boolean)]);
const pool = loadItems(ROOT).filter(i => !taken.has(i.id) && extractNumbers(i.question).length >= min);
const picked = books.flatMap(b => sampleItems(pool, {n, seed: `${opt('--seed', 'sd-stage1')}/${b}`, books: [b], seen: taken}));
fs.writeFileSync(opt('--out', '/dev/stdout'), picked.map(i => i.id).join('\n') + '\n');
console.error(`${picked.length} problems (${books.join(', ')}, ${n} each, at least ${min} numbers)`);
