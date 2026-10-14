#!/usr/bin/env node
/**
 * Speed table of the Datalog strategies (datalog-agent): the shapes of smoke cases 65 to 69 at 10^3 to 10^6 facts, one process per cell with a
 * wall-clock limit, answers checked against the answer known by construction.
 *
 *   node eval/smoke-reasoning/bench/datalog.mjs [--quick] [--limit-s 120] [--markdown] [--only ring,dense]
 *
 * `--quick` stops at 10^5 facts. The report goes to eval/reports/current/smoke-reasoning/datalog-speed.json (a regenerable observation:
 * numbers depend on the machine, see its `machine` block). Cells: js-oracle (naive, small sizes), datalog-souffle (interpreter; interpreter with
 * magic sets; compiled with its cache), datalog-e10 (demand on and off), datalog-soplab (small sizes), sql-sqlite when the strategy exists.
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const quick = args.includes('--quick');
const limitS = Number(opt('--limit-s', 120));
const only = opt('--only', null)?.split(',');

const hasSql = fs.existsSync(path.join(repo, 'reasoning/strategies/sql-sqlite/index.mjs'));

// shape, label of the size, parameters, facts, which engines run it
const CELLS = [
  ['ring', '10^2', {components: 10, size: 10}], ['ring', '10^3', {components: 100, size: 10}], ['ring', '10^4', {components: 1000, size: 10}], ['ring', '10^5', {components: 10000, size: 10}], ['ring', '10^6', {components: 100000, size: 10}],
  ['selective', '10^4', {components: 200, size: 50}], ['selective', '10^5', {components: 2000, size: 50}],
  ['dense', '100 nodes', {nodes: 100, density: 3}], ['dense', '200 nodes', {nodes: 200, density: 3}], ['dense', '300 nodes', {nodes: 300, density: 3}],
  ['negation', '10^4', {nodes: 6000}], ['negation', '10^5', {nodes: 60000}], ['negation', '10^6', {nodes: 600000}],
  ['aggregates', '10^4', {rows: 10000, departments: 100}], ['aggregates', '10^5', {rows: 100000, departments: 1000}], ['aggregates', '10^6', {rows: 1000000, departments: 10000}]
];

const factsOf = (shape, p) => ({ring: p.components * p.size, selective: p.components * p.size + 5, dense: null, negation: Math.round(p.nodes * (1 + 1 / 3 + 1 / 7)), aggregates: p.rows}[shape]);

/** engine, options, label; `maxFacts` is the largest instance the engine is asked to run (the naive and in-process engines stop early). */
const ENGINES = [
  {id: 'js-oracle', label: 'js-oracle', options: {}, maxFacts: 400},
  {id: 'datalog-souffle', label: 'souffle interpret', options: {}, maxFacts: Infinity},
  {id: 'datalog-souffle', label: 'souffle interpret -m', options: {magic: true}, maxFacts: Infinity, shapes: ['selective', 'ring']},
  {id: 'datalog-souffle', label: 'souffle compiled (cached run)', options: {mode: 'compile'}, maxFacts: Infinity, reps: 2, shapes: ['ring', 'selective']},
  {id: 'datalog-e10', label: 'e10 demand', options: {}, maxFacts: Infinity},
  {id: 'datalog-e10', label: 'e10 no demand', options: {demand: false}, maxFacts: Infinity, shapes: ['ring', 'selective', 'dense']},
  {id: 'datalog-soplab', label: 'soplab', options: {}, maxFacts: 60000},
  ...(hasSql ? [{id: 'sql-sqlite', label: 'sql-sqlite', options: {}, maxFacts: Infinity}] : [])
];

function measure(spec) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=24000', path.join(here, 'datalog-worker.mjs'), JSON.stringify(spec)], {encoding: 'utf8', timeout: limitS * 1000, maxBuffer: 1 << 26});
  if (r.error?.code === 'ETIMEDOUT') return {ok: true, timedOut: true};
  const line = (r.stdout || '').trim().split('\n').at(-1);
  try { return JSON.parse(line); } catch { return {ok: false, error: (r.stderr || r.stdout || String(r.error)).slice(-200)}; }
}

const budget = {timeoutMs: (limitS - 10) * 1000, maxJoins: 2_000_000_000, maxFacts: 50_000_000, maxRounds: 100000, maxNodes: 1_000_000};
const results = [];
for (const [shape, size, params] of CELLS) {
  if (only && !only.includes(shape)) continue;
  if (quick && /10\^6/.test(size)) continue;
  for (const e of ENGINES) {
    if (e.shapes && !e.shapes.includes(shape)) continue;
    const facts = factsOf(shape, params);
    if (facts !== null && facts > e.maxFacts) { results.push({shape, size, engine: e.label, skipped: 'too large for this engine'}); continue; }
    if (e.id === 'js-oracle' && shape === 'dense' && params.nodes > 100) { results.push({shape, size, engine: e.label, skipped: 'too large for this engine'}); continue; }
    if (e.id === 'datalog-soplab' && shape === 'dense' && params.nodes > 100) { results.push({shape, size, engine: e.label, skipped: 'too large for this engine'}); continue; }
    const t0 = performance.now();
    const m = measure({shape, params, engine: e.id, options: e.options, budget, reps: e.reps ?? 1});
    const cell = {shape, size, engine: e.label, facts, ...m, wallS: Math.round((performance.now() - t0) / 100) / 10};
    results.push(cell);
    console.error(`${shape.padEnd(10)} ${size.padEnd(10)} ${e.label.padEnd(30)} ${cell.timedOut ? 'TIMEOUT' : cell.ok ? `${cell.ms} ms ${cell.status}${cell.complete ? '' : ' (' + cell.reason + ')'} ${cell.correct === false ? 'WRONG' : ''}` : 'ERROR ' + cell.error}`);
  }
}

const machine = {cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGb: Math.round(os.totalmem() / 2 ** 30), node: process.version, platform: `${os.platform()} ${os.arch()}`};
const out = path.join(repo, 'eval/reports/current/smoke-reasoning/datalog-speed.json');
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify({generated: new Date().toISOString(), note: 'Regenerable observation (eval/smoke-reasoning/bench/datalog.mjs): wall time of ask() in ms, one process per cell, the instance pre-parsed into structured wires.', limitS, machine, results}, null, 2) + '\n');

const fmt = c => (c.skipped ? '-' : c.timedOut ? `> ${limitS} s` : !c.ok ? 'error' : c.complete === false ? `${c.ms} ms (${c.reason})` : `${c.ms} ms${c.correct === false ? ' WRONG' : ''}`);
const engines = [...new Set(results.map(r => r.engine))];
const rows = [...new Set(results.map(r => `${r.shape} ${r.size}`))];
console.log('| shape and size | ' + engines.join(' | ') + ' |');
console.log('| --- | ' + engines.map(() => '---').join(' | ') + ' |');
for (const row of rows) console.log(`| ${row} | ` + engines.map(e => { const c = results.find(r => `${r.shape} ${r.size}` === row && r.engine === e); return c ? fmt(c) : ''; }).join(' | ') + ' |');
console.error('report: ' + path.relative(repo, out));
