#!/usr/bin/env node
/**
 * Speed of exact decimal arithmetic per engine (owner question 2026-10-02): N decimal prices with two decimals, a line total per price
 * (price times a constant, 0.07 tax), and a sum, a count, a minimum and a maximum over them; the answer is built without asking an
 * engine (integer cents). Every cell runs in its own process with a wall limit.
 *
 *   node tools/eval/engines/exact-decimals-bench.mjs [--sizes 1000,10000,100000] [--engines js-reference,sql-sqlite,...] [--limit-s 120]
 *     [--out eval/reports/current/exact-decimals/timing.json]
 *   node tools/eval/engines/exact-decimals-bench.mjs --cell sql-sqlite:100000      one cell (the child process)
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
/** Known limits, not measured: Z3's let chain over thousands of terms overflows the s-expression reader (also with integers). */
const CAPS = {'z3-smt-bounded': 1000};
const ENGINES = ['js-reference', 'sql-sqlite', 'datalog-souffle', 'asp-clingo', 'prolog-tabling', 'z3-smt-bounded'];

/** N prices of the form 1.00 + (i mod 9000)/100 and the exact sum, min, max in integer cents. */
function build(n) {
  const out = ['@price predicate\n  args subject:entity object:rational\n  closed true\n@total predicate\n  args subject:entity object:rational\n  closed true\n',
    '@s_sum predicate\n  args subject:entity object:rational\n@s_n predicate\n  args subject:entity object:integer\n@s_min predicate\n  args subject:entity object:rational\n@s_max predicate\n  args subject:entity object:rational\n'];
  let cents = 0, min = Infinity, max = -Infinity, taxCents = 0;
  for (let i = 0; i < n; i++) {
    const c = 100 + (i % 9000);
    cents += c; min = Math.min(min, c); max = Math.max(max, c);
    out.push(`@p${i} fact\n  holds price i${i} ${(c / 100).toFixed(2)}\n`);
    taxCents += c * 7;   // price times 0.07 in cents-of-cents
  }
  out.push('@r_tax rule\n  when price ?i ?p\n  when compute ?t ?p times 0.07\n  then total ?i ?t\n',
    '@a_sum aggregate\n  over total ?i ?t\n  sum ?t as ?s\n  yields s_sum all ?s\n',
    '@a_n aggregate\n  over price ?i ?p\n  count ?i as ?k\n  yields s_n all ?k\n',
    '@a_min aggregate\n  over price ?i ?p\n  min ?p as ?m\n  yields s_min all ?m\n',
    '@a_max aggregate\n  over price ?i ?p\n  max ?p as ?m\n  yields s_max all ?m\n');
  const query = '@q query\n  mode select\n  select ?k ?v\n  where any\n    s_sum ?k ?v\n    s_n ?k ?v\n    s_min ?k ?v\n    s_max ?k ?v\n  end\n';
  const expected = [{k: 'all', v: Number((taxCents / 10000).toFixed(4))}, {k: 'all', v: n}, {k: 'all', v: min / 100}, {k: 'all', v: max / 100}];
  return {knowledge: out.join(''), query, expected};
}

async function cell(engine, n) {
  const {knowledge, query, expected} = build(n);
  const mods = {
    'js-reference': '../../../reasoning/strategies/js-reference/index.mjs', 'sql-sqlite': '../../../reasoning/strategies/sql-sqlite/index.mjs',
    'datalog-souffle': '../../../reasoning/strategies/datalog-souffle/index.mjs', 'asp-clingo': '../../../reasoning/strategies/asp-clingo/index.mjs',
    'prolog-tabling': '../../../reasoning/strategies/prolog-tabling/index.mjs', 'z3-smt-bounded': '../../../reasoning/strategies/z3-smt-bounded/index.mjs'
  };
  const m = await import(mods[engine]);
  const ask = m.ask ?? m.default.ask;
  const t0 = performance.now();
  let result;
  try {
    const p = ask({theory: {knowledge}, query}, {timeoutMs: 110000}, {conditional: false});
    const key = r => JSON.stringify(Object.entries(r).sort());
    const got = (p.rows ?? []).map(key).sort(), want = expected.map(key).sort();
    result = {status: p.status, reason: p.reason ?? null, correct: p.status === 'supported' ? JSON.stringify(got) === JSON.stringify(want) : null, notes: p.notes ?? []};
  } catch (e) { result = {status: 'error', error: String(e.message).slice(0, 160)}; }
  console.log(JSON.stringify({engine, facts: n, ms: Math.round(performance.now() - t0), ...result}));
}

if (opt('--cell')) { const [e, n] = opt('--cell').split(':'); await cell(e, Number(n)); process.exit(0); }

const sizes = opt('--sizes', '1000,10000,100000').split(',').map(Number);
const engines = opt('--engines', ENGINES.join(',')).split(',');
const limit = Number(opt('--limit-s', '120')) * 1000;
const rows = [];
for (const n of sizes) for (const engine of engines) {
  if (n > (CAPS[engine] ?? Infinity)) { rows.push({engine, facts: n, status: 'skipped', ms: null, reason: `known limit above ${CAPS[engine]} facts`}); continue; }
  const r = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--cell', `${engine}:${n}`], {encoding: 'utf8', timeout: limit, maxBuffer: 1 << 26});
  const line = (r.stdout ?? '').split('\n').filter(l => l.startsWith('{')).at(-1);
  const row = line ? JSON.parse(line) : {engine, facts: n, status: r.error?.code === 'ETIMEDOUT' ? 'timeout' : 'error', ms: null, error: (r.stderr ?? '').slice(0, 160)};
  rows.push(row);
  console.log(`${String(n).padStart(7)}  ${engine.padEnd(16)} ${String(row.status).padEnd(18)} ${row.ms === null ? '' : row.ms + ' ms'}  ${row.correct === true ? 'correct' : row.correct === false ? 'WRONG' : (row.reason ?? row.error ?? '')}`);
}
const out = opt('--out', path.join(project, 'eval/reports/current/exact-decimals/timing.json'));
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify({generated: new Date().toISOString(), query: 'sum of price x 0.07, count, min, max over N two-decimal prices', rows}, null, 1) + '\n');
console.log('report:', path.relative(project, out));
