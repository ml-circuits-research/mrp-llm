#!/usr/bin/env node
/**
 * Timing of the slice path (reasoning/slice/, DS005, DS006 "Completeness under partial retrieval") on a large synthetic SQLite memory.
 *
 *   node tools/eval/engines/slice-timing.mjs [--facts 10000,100000] [--repeats 5] [--out eval/reports/current/slice-path/timing.json]
 *
 * For each size a base memory of that many facts is built the way a base memory is built (published in pieces of 1,000 facts, so its
 * history is a chain of snapshots), then reopened cold (decoded snapshots forgotten) and asked a fixed set of questions through the
 * runtime: a keyed lookup, a two-hop join, a recursive ancestor, a wide recursive descendant count, a select over a hub, a settled
 * count over the hub, a universal question, and a scan of the whole relation. The wide count shows the typed path's inherited
 * 10k-fact limit alongside the knowledge-wire path's recursive-class limit. Per question: median wall-clock milliseconds over repeats
 * and the effective slice class/bounds, steps, probes, status and completeness. CPU only, no model or GPU.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Repository} from '../../../memory/repository.mjs';
import {Runtime} from '../../../sop/runtime.mjs';
import {publishKnowledge} from '../../../sop/ingest.mjs';
import {Theory, askMemory} from '../../../reasoning/slice/index.mjs';
import {samePacket} from '../../../reasoning/router/index.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const sizes = opt('--facts', '10000,100000').split(',').map(Number);
const repeats = Number(opt('--repeats', 5));
const out = path.resolve(project, opt('--out', 'eval/reports/current/slice-path/timing.json'));

const KNOWN = Date.parse('2024-01-01');
const NOW = Date.parse('2026-09-26T12:00:00Z');
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fact = (p, ...t) => `@f${p}_${t.join('_')} fact\n  holds ${p} ${t.join(' ')}\n  valid timeless\n  source synthetic\n`;
const RULES = [['anc1', 'ancestor ?x ?y', 'parent ?x ?y'], ['anc2', 'ancestor ?x ?z', 'parent ?x ?y', 'ancestor ?y ?z'], ['gp', 'grandparent ?x ?z', 'parent ?x ?y', 'parent ?y ?z']];
const rule = (id, head, ...body) => `@${id} rule\n${body.map(b => `  when ${b}\n`).join('')}  then ${head}\n`;

/** n facts: a tree of `parent` facts (fan-out 3), `lives_in` facts, a hub `member ... club`, and filler relations. */
function* generate(n) {
  const tree = Math.floor(n / 2), lives = Math.floor(n / 4), hub = Math.min(3000, Math.floor(n / 20));
  for (let i = 1; i <= tree; i++) yield fact('parent', 'n' + i, 'n' + Math.floor((i - 1) / 3));
  for (let i = 0; i < lives; i++) yield fact('lives_in', 'n' + i, 'city' + (i % 997));
  for (let i = 0; i < hub; i++) yield fact('member', 'n' + (i * 7 % tree), 'club');
  for (let i = tree + lives + hub; i < n; i++) yield fact('filler' + (i % 19), 'n' + (i % tree), 'v' + (i % 4001));
}

function build(root, n) {
  const repo = new Repository(root, {memory: {engine: 'sqlite', sharding: {enabled: true, mode: 'archive', maxClaimsPerShard: 1024, safeOccupancy: 0.55, maxColdShards: 8}}});
  const t0 = performance.now();
  publishKnowledge(repo, 'base',
    RULES.map(r => rule(...r)).join(''),
    {reviewed: true, knownAt: KNOWN});
  let chunk = [], published = 0;
  const flush = () => { if (chunk.length) { publishKnowledge(repo, 'base', chunk.join('\n'), {reviewed: true, knownAt: KNOWN}); published += chunk.length; chunk = []; } };
  for (const f of generate(n)) { chunk.push(f); if (chunk.length >= 1000) flush(); }
  flush();
  return {buildMs: Math.round(performance.now() - t0), published};
}

const ask = (where, {mode = null, select = '?x', extra = ''} = {}) =>
  `@q query\n${mode ? `  mode ${mode}\n` : ''}${select ? `  select ${select}\n` : ''}  where ${where}\n${extra}  at 2026-09-26\n@m recall\n  query $q\n@r reason\n  query $q\n  memory $m\n`;

const QUESTIONS = n => {
  const leaf = 'n' + Math.floor(n / 2 - 1);
  return [
    {id: 'keyed_lookup', text: 'the parent of one node', program: ask(`parent ${leaf} ?x`)},
    {id: 'two_hop_join', text: 'the grandparent of one node (a rule with a join)', program: ask(`grandparent ${leaf} ?x`)},
    {id: 'recursive_ancestor', text: 'all ancestors of a deep node (a recursive rule)', program: ask(`ancestor ${leaf} ?x`)},
    {id: 'recursive_descendants_count', text: 'all descendants of the root (recursive demand grows beyond 10k at 25k input facts)', program: ask('ancestor ?x n0', {mode: 'count', select: ''})},
    {id: 'hub_select', text: 'the members of the hub (a select that needs the cap widened)', program: ask('member ?x club')},
    {id: 'hub_count', text: 'a count over the hub (needs a settled slice)', program: ask('member ?x club', {mode: 'count'})},
    {id: 'hub_every', text: 'does every member of the hub live somewhere (a universal question)', program: ask('member ?x club', {mode: 'every', select: '', extra: '  scope lives_in ?x ?c\n'})},
    {id: 'scan_count', text: 'a count over the whole parent relation (needs a scan: honest incomplete)', program: ask('parent ?x ?y', {mode: 'count'})},
  ];
};

async function measure(root, n) {
  Repository.clearShared();
  const t0 = performance.now();
  const repo = new Repository(root, {memory: {engine: 'sqlite'}});
  const session = repo.session('base', 'timing', 's' + Date.now());
  repo.visible(session);
  const coldLoadMs = Math.round(performance.now() - t0);
  const runtime = () => new Runtime({repo, session, now: NOW});
  const rows = [];
  for (const q of QUESTIONS(n)) {
    const times = []; let packet = null;
    for (let i = 0; i < repeats; i++) {
      const t = performance.now();
      const r = await runtime().run(q.program);
      times.push(performance.now() - t);
      packet = r.values.r;
    }
    const rep = packet.retrieval;
    rows.push({
      id: q.id, text: q.text, first_ms: Math.round(times[0]), median_ms: Math.round(median(times)),
      status: packet.status, answers: packet.answers?.length ?? null, count: packet.count ?? null, at_least: packet.at_least ?? null,
      complete: rep.complete, class: rep.class, bound: rep.bound, steps: rep.steps, lookups: rep.lookups, scans: rep.scans, probes: rep.probes, facts: rep.facts, rules: rep.rules,
      reasons: rep.reasons.slice(0, 3),
    });
  }
  // The knowledge-wire path (askMemory): the same questions, the oracle alone against the StrategyRouter (`auto`), both on the slice the
  // retrieval hands over. The typed rows above always run the oracle (a typed answer carries its proof and validity).
  const theory = new Theory([{name: 'rules', text: RULES.map(r => rule(...r)).join('')}]);
  const wireRows = [];
  for (const q of QUESTIONS(n)) {
    const text = q.program.split('@m recall')[0];
    const arm = reasoning => {
      const times = []; let packet = null;
      for (let i = 0; i < repeats; i++) { const t = performance.now(); packet = askMemory({theory, repo, session, query: text, reasoning}); times.push(performance.now() - t); }
      return {packet, first_ms: Math.round(times[0]), median_ms: Math.round(median(times))};
    };
    const oracle = arm('reference'), router = arm('auto');
    wireRows.push({
      id: q.id, oracle_ms: oracle.median_ms, router_ms: router.median_ms, oracle_first_ms: oracle.first_ms, router_first_ms: router.first_ms,
      status: oracle.packet.status, router_status: router.packet.status, slice_facts: oracle.packet.retrieval?.facts ?? null, complete: oracle.packet.retrieval?.complete ?? null,
      class: router.packet.retrieval?.class ?? null, bound: router.packet.retrieval?.bound ?? null, reasons: router.packet.retrieval?.reasons ?? null,
      chosen: router.packet.route?.chosen ?? null, rule: router.packet.route?.rule ?? null, verification: router.packet.route?.verification?.outcome ?? null,
      agree: samePacket(oracle.packet, router.packet),
    });
  }
  return {coldLoadMs, snapshots: repo.visible(session).length - 1, rows, wireRows};
}

const report = {
  ran_at: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, repeats,
  note: 'Synthetic memory; CPU only. first_ms includes building the SQL banks the question touches (lazy); median_ms is warm.',
  sizes: [],
};
for (const n of sizes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-timing-'));
  try {
    console.error(`building ${n} facts ...`);
    const built = build(root, n);
    console.error(`built in ${built.buildMs} ms; measuring`);
    const measured = await measure(root, n);
    report.sizes.push({facts: n, ...built, ...measured});
    for (const r of measured.rows) console.error(`  ${String(n).padStart(7)} ${r.id.padEnd(18)} first ${String(r.first_ms).padStart(5)} ms  median ${String(r.median_ms).padStart(5)} ms  ${r.status} complete=${r.complete} steps=${r.steps} lookups=${r.lookups} facts=${r.facts}`);
    for (const r of measured.wireRows) console.error(`  ${String(n).padStart(7)} ${r.id.padEnd(18)} wire path: oracle ${String(r.oracle_ms).padStart(5)} ms  router ${String(r.router_ms).padStart(5)} ms -> ${r.chosen} [${r.rule}] agree=${r.agree}`);
    console.error(`  cold load of the base memory: ${measured.coldLoadMs} ms (${measured.snapshots} snapshots)`);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({out: path.relative(project, out), sizes: report.sizes.map(s => ({facts: s.facts, coldLoadMs: s.coldLoadMs}))}));
