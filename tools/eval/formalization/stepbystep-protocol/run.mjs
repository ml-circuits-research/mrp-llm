#!/usr/bin/env node
/**
 * eval-stepbystep-protocol-v1: LocalLLMStepByStep question protocols (A current; B, C, D and the ablations of the generic protocol)
 * on dev rows of four levels, through the symbolic-vs-llm harness `runArm` (arm B-stepbystep) unchanged:
 *   a  known forms F2-F9 (eval/smoke-reasoning/bench/manifest.jsonl, stageRows seed 20261002, the T10 rows excluded)
 *   b  the held-out forms of tools/datasets/diversity/generality.mjs, instances 1..per
 *   c  the compositions of the same generator, instances 1..per
 *   n  the natural questions tools/eval/formalization/generality/natural-v1.jsonl (world-v1)
 * The tuning pool (--pool tuning) is disjoint from every measured row: level a from stageRows seed 777 outside the 10-per-family
 * measured set, level b/c instances 11..10+per; natural rows are never in the tuning pool.
 *   node tools/eval/formalization/stepbystep-protocol/run.mjs --methods A,D --levels a,b,c,n --per 3 [--local-tier micro] \
 *     --out eval/reports/current/stepbystep-protocol/stage1 [--pool measured|tuning] [--ids x,y]
 * The questions go to the Ploinky tier --local-tier (default micro, the local Qwen3-4B-Instruct that Ploinky starts on demand).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {generalityCases} from '../../../datasets/diversity/generality.mjs';
import {runArm, evidenceFor, stageRows} from '../../symbolic-vs-llm/run.mjs';
import {createWorld, execute, goldSlice} from '../../symbolic-vs-llm/world.mjs';
import {score} from '../../symbolic-vs-llm/score.mjs';
import {naturalRows, rescore} from '../generality/run.mjs';
import {verifyAnswer} from '../../../../reasoning/strategies/js-reference/index.mjs';
import {openSession} from '../../lib/session.mjs';
import {parse} from '../../../../sop/knowledge/lexical.mjs';
import {STEP_BY_STEP_METHODS} from '../../../../lib/formalize/strategies.mjs';
import {DEFAULT_LOCAL_TIER} from '../../symbolic-vs-llm/run.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MANIFEST = path.join(ROOT, 'eval/smoke-reasoning/bench/manifest.jsonl');
const NATURAL_TUNING = path.join(ROOT, 'eval/reports/current/stepbystep-protocol/natural-tuning.jsonl');
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const strip = ({requires, ...rest}) => rest;
export const FAMILIES = ['f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'];

/** Level a rows: per family, `per` rows of the measured pool (seed 20261002) or of the disjoint tuning pool (seed 777). */
export function levelA({per = 3, pool = 'measured'} = {}) {
  const rows = fs.readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.split === 'dev' && FAMILIES.includes(r.family));
  const out = [];
  for (const family of FAMILIES) {
    const all = rows.filter(r => r.family === family);
    const t10 = new Set(stageRows(all, 5, 20261001).map(r => r.id));
    const candidates = all.filter(r => !t10.has(r.id));
    const measured = stageRows(candidates, 10, 20261002);
    if (pool === 'measured') out.push(...measured.slice(0, per));
    else { const ids = new Set(measured.map(r => r.id)); out.push(...stageRows(candidates.filter(r => !ids.has(r.id)), per, 777)); }
  }
  return out.map(r => ({...r, level: 'a', form: r.family}));
}

/** Level b and c rows: instances 1..per (measured) or 11..10+per (tuning). */
export function levelBC({per = 3, pool = 'measured', levels = ['b', 'c']} = {}) {
  const first = pool === 'measured' ? 1 : 11;
  return generalityCases({per: first - 1 + per}).filter(r => levels.includes(r.level) && Number(r.id.split('-').at(-1)) >= first);
}

export function protocolRows({levels = ['a', 'b', 'c', 'n'], per = 3, pool = 'measured'} = {}) {
  return [...(levels.includes('a') ? levelA({per, pool}) : []), ...levelBC({per, pool, levels: levels.filter(l => ['b', 'c'].includes(l))}),
    ...(levels.includes('n') && pool === 'measured' ? naturalRows() : []),
    // Fresh natural questions for tuning only (no gold: inspected by hand), never the measured natural set.
    ...(levels.includes('n') && pool === 'tuning' && fs.existsSync(NATURAL_TUNING) ? naturalRows(NATURAL_TUNING).map(r => ({...r, expected: {manual: true}})) : [])];
}

export function prepare(row, shared) {
  if (row.level === 'a') {
    const dir = path.resolve(path.dirname(MANIFEST), row.case_dir);
    const knowledge = fs.readFileSync(path.join(dir, 'knowledge.sop'), 'utf8'), query = fs.readFileSync(path.join(dir, 'query.sop'), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    const world = createWorld(knowledge), gold = execute(world, query);
    if (score(expected, gold).outcome !== 'correct') throw new Error(`${row.id}: gold fails on the product path`);
    const slice = goldSlice(world, query, gold);
    return {world, gold, slice, evidence: evidenceFor(slice, row.question), knowledge, query, expected, own: true};
  }
  if (row.base_memory === 'world-v1') {
    const world = shared();
    const query = row.query ?? row.evidence_query ?? null;
    const gold = query ? execute(world, query) : {status: 'unknown', complete: true};
    const slice = query ? goldSlice(world, query, gold) : {facts: [], wires: []};
    const evidence = query ? evidenceFor(slice, row.question) : {source: '', evidence_does_not_fit: false, facts: 0, original_chars: 0};
    return {world, gold, slice, evidence, knowledge: '', query: query ?? '@q query\n  where unknown_relation ?x\n  select ?x\n', expected: row.expected, own: false};
  }
  const world = createWorld(row.knowledge);
  const gold = verifyAnswer({theory: {knowledge: row.knowledge + (row.gold_defs ?? '')}, query: row.query});
  const check = score(strip(row.expected), gold).outcome;
  if (check !== 'correct' && !(row.expected.status === 'refuted' && gold.status === 'unknown')) throw new Error(`${row.id}: gold circuit disagrees with the constructed answer (${gold.status})`);
  return {world, gold, slice: {facts: [], wires: parse(row.knowledge).wires}, evidence: {source: '', evidence_does_not_fit: false, facts: 0, original_chars: 0}, knowledge: row.knowledge, query: row.query, expected: row.expected, own: true};
}

export async function main(args = process.argv.slice(2)) {
  const methods = opt(args, '--methods', 'A').split(',');
  for (const m of methods) if (!STEP_BY_STEP_METHODS.includes(m)) throw new Error(`methods: ${STEP_BY_STEP_METHODS.join(', ')}`);
  for (const gone of ['--endpoint', '--model']) if (args.includes(gone)) throw new Error(`${gone} is gone: every model call goes through Ploinky; name the tier with --local-tier (default ${DEFAULT_LOCAL_TIER})`);
  const localTier = opt(args, '--local-tier', DEFAULT_LOCAL_TIER);
  const levels = opt(args, '--levels', 'a,b,c,n').split(','), per = Number(opt(args, '--per', 3)), pool = opt(args, '--pool', 'measured');
  let rows = protocolRows({levels, per, pool});
  const ids = opt(args, '--ids', null)?.split(',');
  if (ids) rows = rows.filter(r => ids.includes(r.id));
  const sample = Number(opt(args, '--sample', 0));
  if (sample) rows = rows.map(r => ({r, k: createHash('sha256').update(`${opt(args, '--seed', 'tune')}/${r.id}`).digest('hex')})).sort((a, b) => a.k.localeCompare(b.k)).slice(0, sample).map(x => x.r);
  const out = path.resolve(opt(args, '--out', path.join(ROOT, 'eval/reports/current/stepbystep-protocol/run')));
  fs.mkdirSync(out, {recursive: true});
  const file = path.join(out, 'records.jsonl');
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return `${r.id}/${r.method}`; }) : []);
  const settings = {model: `tier:${localTier}`, localTier, purpose: 'job:stepbystep-protocol', wallMs: Number(opt(args, '--wall-ms', 180000)), maxTokens: Number(opt(args, '--max-tokens', 4096))};
  // Provenance: the protocol code digest per method run (a changed protocol is a new run, never mixed into the same records).
  const dir = path.join(ROOT, 'lib/query-author/step-by-step');
  const code = createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) code.update(f).update(fs.readFileSync(path.join(dir, f)));
  const identity = {protocol_sha256: code.digest('hex'), model: settings.model, local_tier: localTier, levels, per, pool, rows: rows.length, started: new Date().toISOString()};
  for (const method of methods) {
    const file = path.join(out, `run-${method}.json`);
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).protocol_sha256 !== identity.protocol_sha256 && !args.includes('--allow-changed')) throw new Error(`${method}: the protocol code changed since this run started; use a fresh --out`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({...identity, method}, null, 2) + '\n');
  }
  let world1 = null;
  const shared = () => {
    if (!world1) {
      const session = openSession({base: 'world-v1', id: `stepbystep-${process.pid}`});
      const entry = session.store.get('qf', 'stepbystep', 'main');
      world1 = {chat: session, repo: session.store.repo, session: entry.agent.session, lexicon: session.lexicon,
        theory: session.theories.get([...session.sessions.baseCircuits(session.id), ...session.sessions.circuits(session.id)]), dispose: session.close};
    }
    return world1;
  };
  try {
    for (const method of methods) for (const row of rows) {
      if (done.has(`${row.id}/${method}`)) continue;
      let prepared;
      try { prepared = prepare(row, shared); } catch (error) { console.error(`${row.id} skipped: ${error.message}`); continue; }
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stepbystep-protocol-'));
      try {
        const record = await runArm({row: {...row, family: row.form, expected: strip(prepared.expected)}, arm: 'B-stepbystep', world: prepared.world, gold: prepared.gold,
          slice: prepared.slice, evidence: prepared.evidence, knowledge: prepared.knowledge, query: prepared.query, settings: {...settings, stepMethod: method}, folder});
        const outcome = row.level === 'a' ? record.outcome : rescore(row, record);
        const full = {...record, method, level: row.level, form: row.form, question: row.question, pool, outcome_harness: record.outcome, outcome, expected: row.expected,
          questions: record.author?.steps?.length ?? 0, formalize_ms: record.latency?.parse_ms ?? null};
        fs.appendFileSync(file, JSON.stringify(full) + '\n');
        console.error(`${row.id} ${method} ${outcome} q=${full.questions} ${full.formalize_ms}ms ${record.packet?.status ?? ''} ${record.author?.status ?? ''}`);
      } finally {
        fs.rmSync(folder, {recursive: true, force: true});
        if (prepared.own) prepared.world.dispose();
      }
    }
  } finally { world1?.dispose(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
