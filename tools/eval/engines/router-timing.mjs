#!/usr/bin/env node
/**
 * Measure wire-level StrategyRouter cells. Every cell runs in an isolated process, with a wall limit;
 * the deterministic expected answer is constructed without asking an engine.
 *
 *   node tools/eval/engines/router-timing.mjs [--quick] [--only ring,closure-rank,closure-count,negation-complete]
 *     [--engines reference,sql-sqlite,auto] [--sizes 10^3,10^4] [--limit-s 60]
 *     [--verify-offline --verify-timeout-ms 120000] [--out eval/reports/current/router/timing.json]
 *
 * `--cell '{"shape":"closure-count","params":{"facts":1000},"engine":"auto"}'` runs one cell.
 * `ms` measures only the ask (including online verification, if any); offline verification is separate.
 * Unsupported, incomplete, timed-out and failed cells are not scored as correct or incorrect.
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '../../../sop/knowledge/index.mjs';
import * as scale from '../../../eval/smoke-reasoning/bench/datalog-scale.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const SHAPES = {ring: scale.ringComponents, selective: scale.selectiveChain, dense: scale.denseNonlinear, negation: scale.negationChain, aggregates: scale.groupAggregates};

const FACT = (id, text) => `@${id} fact\n  holds ${text}\n`;
const TARGETS = [1_000, 10_000, 100_000, 1_000_000];

// A shallow fanout tree makes the requested closure itself large: O(N) reachable rows, depth two.
// The numeric rank joins every leaf to a score, rather than ranking a tiny isolated component.
function closureTree(facts, ranked) {
  const branches = 100, leaves = ranked ? (facts - branches) / 2 : facts - branches;
  if (!Number.isSafeInteger(leaves) || leaves < branches) throw new Error('closure tree requires at least 200 facts (rank: 300) and an integral leaf count');
  const out = ['@edge predicate\n  args source:entity destination:entity\n  closed true\n@reach predicate\n  args source:entity destination:entity\n  closed true\n',
    '@r_base rule\n  when edge ?a ?b\n  then reach ?a ?b\n@r_step rule\n  when reach ?a ?b\n  when edge ?b ?c\n  then reach ?a ?c\n'];
  if (ranked) out.push('@score predicate\n  args subject:entity value:integer\n');
  for (let i = 0; i < branches; i++) out.push(FACT(`branch${i}`, `edge origin branch${i}`));
  for (let i = 0; i < leaves; i++) {
    out.push(FACT(`edge${i}`, `edge branch${i % branches} leaf${i}`));
    if (ranked) out.push(FACT(`score${i}`, `score leaf${i} ${i >= leaves - 2 ? 1000 : i % 997}`));
  }
  return {knowledge: out.join(''), facts, reachable: branches + leaves, candidates: ranked ? leaves : branches + leaves,
    query: ranked ? '@q query\n  where reach origin ?y\n  where score ?y ?v\n  select ?y\n  rank highest ?v\n'
      : '@q query\n  mode count\n  where reach origin ?y\n',
    answer: ranked ? {rows: [{y: `leaf${leaves - 2}`}, {y: `leaf${leaves - 1}`}]} : {count: branches + leaves}};
}

function closureRank({facts}) { return closureTree(facts, true); }
function closureCount({facts}) { return closureTree(facts, false); }

// Closed base declarations plus ALL generated facts give a complete finite domain for absence.
// A count keeps the million-fact cell's output small; an open output predicate still gives only a lower bound.
function negationComplete({nodes, targetFacts = null, outputClosed = true}) {
  const decl = n => `@${n} predicate\n  args subject:entity\n  closed true\n`;
  const out = [decl('node'), decl('blocked'), decl('special'), decl('s1'), decl('s2'),
    outputClosed ? decl('s3') : '@s3 predicate\n  args subject:entity\n'];
  let facts = 0, count = 0;
  for (let i = 0; i < nodes; i++) {
    out.push(FACT(`n${i}`, `node n${i}`)); facts++;
    if (i % 3 === 0) { out.push(FACT(`b${i}`, `blocked n${i}`)); facts++; }
    if (i % 7 === 0) { out.push(FACT(`s${i}`, `special n${i}`)); facts++; }
    if (i % 3 !== 0 && i % 7 !== 0) count++;
  }
  // Some target sizes fall between successive whole-node blocks. Extra blocked facts about
  // entities outside the node domain affect neither absence over node nor the expected count.
  if (targetFacts !== null) {
    if (targetFacts < facts) throw new Error('negation target is smaller than the generated base');
    for (let i = facts; i < targetFacts; i++) out.push(FACT(`pad${i}`, `blocked outside${i}`));
    facts = targetFacts;
  }
  out.push('@r1 rule\n  when node ?x\n  when absent blocked ?x\n  then s1 ?x\n@r2 rule\n  when node ?x\n  when absent s1 ?x\n  then s2 ?x\n@r3 rule\n  when node ?x\n  when absent s2 ?x\n  when absent special ?x\n  then s3 ?x\n');
  return {knowledge: out.join(''), facts, query: '@q query\n  mode count\n  where s3 ?x\n',
    answer: {count, ...(outputClosed ? {} : {bound: 'at_least'})}};
}

Object.assign(SHAPES, {'closure-rank': closureRank, 'closure-count': closureCount, 'negation-complete': negationComplete,
  'negation-open-count': params => negationComplete({...params, outputClosed: false})});
const negationParams = targetFacts => {
  let nodes = Math.floor(targetFacts * 21 / 31);
  while (nodes + Math.ceil(nodes / 3) + Math.ceil(nodes / 7) > targetFacts) nodes--;
  return {nodes, targetFacts};
};

const CELLS = [
  ['ring', '10^2', {components: 10, size: 10}], ['ring', '3x10^2', {components: 30, size: 10}], ['ring', '6x10^2', {components: 60, size: 10}], ['ring', '10^3', {components: 100, size: 10}], ['ring', '10^4', {components: 1000, size: 10}], ['ring', '10^5', {components: 10000, size: 10}],
  ['selective', '10^4', {components: 200, size: 50}], ['selective', '10^5', {components: 2000, size: 50}],
  ['dense', '30 nodes', {nodes: 30, density: 3}], ['dense', '100 nodes', {nodes: 100, density: 3}], ['dense', '200 nodes', {nodes: 200, density: 3}],
  ['negation', '10^3', {nodes: 600}], ['negation', '10^4', {nodes: 6000}], ['negation', '10^5', {nodes: 60000}],
  ['aggregates', '10^3', {rows: 1000, departments: 20}], ['aggregates', '10^4', {rows: 10000, departments: 100}], ['aggregates', '10^5', {rows: 100000, departments: 1000}],
  ...TARGETS.flatMap(facts => [
    ['closure-rank', `10^${Math.log10(facts)}`, {facts}],
    ['closure-count', `10^${Math.log10(facts)}`, {facts}],
    ['negation-complete', `10^${Math.log10(facts)}`, negationParams(facts)],
    ['negation-open-count', `10^${Math.log10(facts)}`, negationParams(facts)],
  ]),
];
const ENGINE_COLUMNS = ['reference', 'sql-sqlite', 'datalog-souffle', 'asp-clingo', 'auto'];

function parseInChunks(text, size = 400) {
  const blocks = text.split(/\n(?=@)/), wires = [];
  for (let i = 0; i < blocks.length; i += size) {
    const {wires: ws, errors} = parse(blocks.slice(i, i + size).join('\n') + '\n');
    if (errors.length) throw new Error(errors[0].message);
    wires.push(...ws);
  }
  return wires;
}
const key = r => JSON.stringify(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
const sameRows = (a, b) => a.length === b.length && JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort());
const digestAnswer = packet => createHash('sha256').update(packet.count !== undefined
  ? JSON.stringify(['count', packet.status, packet.count, packet.bound ?? null])
  : JSON.stringify(['rows', packet.status, packet.rows.map(key).sort(), packet.bound ?? null])).digest('hex');
const completeAnswer = packet => packet.complete === true && !['unsupported', 'budget_exhausted', 'not_expressible', 'incomplete', 'error'].includes(packet.status);
const correctness = (packet, answer) => !completeAnswer(packet) ? null
  : packet.status === 'supported' && (packet.bound ?? null) === (answer.bound ?? null)
    && (answer.rows ? sameRows(packet.rows ?? [], answer.rows) : packet.count === answer.count);

async function worker(spec) {
  const {routedAsk, verifyPacket} = await import('../../../reasoning/router/index.mjs');
  const make = SHAPES[spec.shape];
  if (!make) throw new Error('Unknown shape: ' + spec.shape);
  const inst = make(spec.params);
  const handle = {kind: 'js-reference-handle', knowledge: '', wires: parseInChunks(inst.knowledge)};
  const t = performance.now();
  const answer = routedAsk({handle, query: inst.query, requested: spec.engine, budget: spec.budget ?? {},
    verify: spec.verifyOffline && spec.engine !== 'reference' ? 'offline' : 'auto'});
  const ms = Math.round(performance.now() - t);
  const correct = correctness(answer, inst.answer);
  const complete = completeAnswer(answer);
  const answerDigest = complete && (answer.rows || answer.count !== undefined) ? digestAnswer(answer) : null;
  const verified = spec.verifyOffline && answer.route?.verification?.outcome === 'deferred'
    ? verifyPacket({handle, query: inst.query, packet: answer, verifyBudget: {timeoutMs: spec.verifyTimeoutMs ?? 120_000}})
    : answer;
  console.log(JSON.stringify({ok: true, facts: inst.facts, reachable: inst.reachable ?? null, candidates: inst.candidates ?? null,
    ms, status: answer.status, complete, bound: answer.bound ?? null,
    reason: answer.code ?? answer.budget?.reason ?? answer.reason ?? null, correct, answerDigest,
    chosen: answer.route?.chosen ?? null, rule: answer.route?.rule ?? null,
    verification: verified.route?.verification?.outcome ?? (verified.route?.verification ? 'skipped' : null),
    verificationMs: verified.route?.verification?.ms ?? null, verificationBudget: verified.route?.verification?.budget ?? null,
    verifiedCorrect: spec.verifyOffline && answer.route?.chosen === 'js-reference' && complete ? correct
      : spec.verifyOffline && verified.route?.verification?.checked === true ? correctness(verified, inst.answer) : null,
    knowledgeCompleteByConstruction: spec.shape === 'negation-complete' || spec.shape === 'negation-open-count' ? true : undefined,
    rssMb: Math.round(process.memoryUsage().rss / 1048576)}));
}

if (args[0] === '--cell') {
  worker(JSON.parse(args[1])).catch(e => { console.log(JSON.stringify({ok: false, error: String(e.message ?? e).slice(0, 300)})); });
} else {
  const list = name => opt(name, null)?.split(',').filter(Boolean) ?? null;
  const only = list('--only'), engines = list('--engines') ?? ENGINE_COLUMNS, sizes = list('--sizes');
  const quick = args.includes('--quick'), verifyOffline = args.includes('--verify-offline');
  const limitS = Number(opt('--limit-s', 60));
  const verifyTimeoutMs = Number(opt('--verify-timeout-ms', 120_000));
  if (!Number.isFinite(limitS) || limitS <= 0) throw new Error('--limit-s must be positive');
  if (!Number.isSafeInteger(verifyTimeoutMs) || verifyTimeoutMs <= 0) throw new Error('--verify-timeout-ms must be a positive integer');
  if (args.includes('--verify-timeout-ms') && !verifyOffline) throw new Error('--verify-timeout-ms requires --verify-offline');
  for (const [name, selected, values] of [['--only', only, Object.keys(SHAPES)], ['--engines', engines, ENGINE_COLUMNS], ['--sizes', sizes, [...new Set(CELLS.map(c => c[1]))]]]) {
    const unknown = selected?.filter(x => !values.includes(x)) ?? [];
    if (unknown.length) throw new Error(`${name}: unknown ${unknown.join(', ')}; choices: ${values.join(', ')}`);
  }
  const out = path.resolve(project, opt('--out', 'eval/reports/current/router/timing.json'));
  // No execution budget: passing one would change `auto` routing to the oracle.
  const results = [];
  const selectedCells = CELLS.filter(([shape, size]) =>
    (!only || only.includes(shape)) && (!sizes || sizes.includes(size)) && (!quick || !/10\^[56]/.test(size)));
  for (const [shape, size, params] of selectedCells) {
    for (const engine of engines) {
      const spec = {shape, params, engine, verifyOffline, verifyTimeoutMs};
      // Allow the separate offline replay its own ceiling, in addition to the ask's wall allowance.
      const timeout = limitS * 1000 + (verifyOffline && engine !== 'reference' ? verifyTimeoutMs + 1000 : 0);
      const r = spawnSync(process.execPath, ['--max-old-space-size=16000', '--no-warnings', fileURLToPath(import.meta.url), '--cell', JSON.stringify(spec)], {encoding: 'utf8', timeout, maxBuffer: 1 << 26});
      let cell;
      if (r.error?.code === 'ETIMEDOUT') cell = {ok: true, timedOut: true, complete: null, correct: null, reason: 'process_wall_limit', timedOutStage: 'process_total'};
      else { try { cell = JSON.parse((r.stdout || '').trim().split('\n').at(-1)); } catch { cell = {ok: false, error: (r.stderr || r.stdout || String(r.error)).slice(-200)}; } }
      results.push({shape, size, engine, ...cell});
      console.error(`${shape.padEnd(18)} ${size.padEnd(10)} ${engine.padEnd(16)} ${cell.timedOut ? 'TIMEOUT' : cell.ok ? `${cell.ms} ms ${cell.status}${cell.complete ? '' : ' (' + cell.reason + ')'}${cell.correct === false ? ' WRONG' : ''}${cell.verification ? ` -> ${cell.chosen} [${cell.rule ?? 'explicit'}, verification ${cell.verification}${cell.verificationMs === null ? '' : ` ${cell.verificationMs} ms`}]` : ''}` : 'ERROR ' + cell.error}`);
    }
  }
  const cells = {};
  for (const r of results) (cells[r.shape + ' ' + r.size] ??= {})[r.engine] = r;
  for (const r of results) {
    const oracle = cells[r.shape + ' ' + r.size].reference;
    r.oracleAgreement = r.engine !== 'reference' && r.complete && oracle?.complete
      ? r.answerDigest === oracle.answerDigest : null;
  }
  const rows = Object.entries(cells).map(([cell, e]) => {
    const oracle = e.reference, router = e.auto;
    const paired = oracle?.complete && router?.complete;
    return {cell, facts: router?.facts ?? oracle?.facts ?? Object.values(e).find(r => r.facts)?.facts ?? null,
      reachable: router?.reachable ?? oracle?.reachable ?? null, candidates: router?.candidates ?? oracle?.candidates ?? null,
      oracle_ms: oracle?.timedOut ? 'timeout' : oracle?.ms ?? null, oracle_complete: oracle?.complete ?? null, oracle_correct: oracle?.correct ?? null,
      oracle_bound: oracle?.bound ?? null,
      router_ms: router?.timedOut ? 'timeout' : router?.ms ?? null, router_chosen: router?.chosen ?? null, router_rule: router?.rule ?? null,
      router_verification: router?.verification ?? null, router_verification_ms: router?.verificationMs ?? null,
      router_complete: router?.complete ?? null, router_correct: router?.correct ?? null, router_bound: router?.bound ?? null,
      router_verified_correct: router?.verifiedCorrect ?? null,
      router_agrees_with_oracle: paired ? oracle.answerDigest === router.answerDigest : null};
  });
  const decided = rows.filter(r => r.router_complete), paired = rows.filter(r => r.router_agrees_with_oracle !== null);
  const summary = {cells: rows.length, attempted: results.length, timed_out: results.filter(r => r.timedOut).length,
    failed: results.filter(r => !r.ok).length, unsupported: results.filter(r => r.status === 'unsupported').length,
    incomplete: results.filter(r => r.ok && !r.complete && !r.timedOut && r.status !== 'unsupported').length,
    router_complete: decided.length, router_correct: decided.filter(r => r.router_correct).length, router_wrong: decided.filter(r => r.router_correct === false).length,
    oracle_complete: rows.filter(r => r.oracle_complete).length, oracle_correct: rows.filter(r => r.oracle_complete && r.oracle_correct).length,
    oracle_wrong: rows.filter(r => r.oracle_complete && r.oracle_correct === false).length,
    oracle_comparisons: results.filter(r => r.oracleAgreement !== null).length,
    oracle_disagreements: results.filter(r => r.oracleAgreement === false).length,
    router_oracle_comparisons: paired.length,
    router_agrees_with_oracle_where_oracle_completes: paired.length ? paired.every(r => r.router_agrees_with_oracle) : null};
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify({generated: new Date().toISOString(),
    note: 'One process per cell. ms excludes instance construction/parsing but includes online verification; offline replay ms is separate. Closed-negation supplies all generated base facts and a closed output predicate; open-count changes only the output predicate and therefore reports at_least. Neither case emulates partial repository retrieval. Missing/timeout/unsupported answers are never scored as correct.',
    limitS, verifyOffline, verifyTimeoutMs: verifyOffline ? verifyTimeoutMs : null, filters: {only, engines, sizes, quick},
    filtered_out_cells: CELLS.length - selectedCells.length,
    machine: {cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGb: Math.round(os.totalmem() / 2 ** 30), node: process.version, platform: `${os.platform()} ${os.arch()}`},
    summary, rows, results}, null, 1) + '\n');
  console.log(JSON.stringify(summary));
}
