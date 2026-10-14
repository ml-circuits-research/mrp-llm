#!/usr/bin/env node
/**
 * eval-internal-reasoning-stepbystep-v1 (status/preregistrations/eval-internal-reasoning-stepbystep-v1.json): InternalReasoningStepByStep
 * against LocalLLMStepByStep method B (unchanged) and the same method B with its questions answered by a larger Ploinky tier, on the rows of
 * eval-stepbystep-protocol-v1 (tools/eval/formalization/stepbystep-protocol/run.mjs `protocolRows`: known forms, held-out forms, compositions, natural
 * questions) through the same harness (`runArm`, `prepare`, `rescore`). Arms:
 *   IR         InternalReasoningStepByStep, the planner decides each question (slot `reasoning`)
 *   IR-greedy  the same protocol, the askable question of lowest priority (ablation)
 *   B          LocalLLMStepByStep method B (slot `steps`)
 *   GLM        LocalLLMStepByStep method B with its questions answered by the Ploinky tier --tier (default small; arm C of the harness; the
 *              name GLM is kept for the record files, whose earlier rows were one-shot LLMDirect, archived on 2026-10-02)
 *   node tools/eval/formalization/internal-reasoning/run.mjs --arms IR,B [--local-tier micro] --out eval/reports/current/internal-reasoning/stage1 \
 *     [--pool measured|tuning] [--levels a,b,c,n] [--per 3] [--sample N --seed S] [--ids x,y] [--limit N]
 * The local arms ask the Ploinky tier --local-tier (default micro, the local Qwen3-4B-Instruct that Ploinky starts on demand).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {protocolRows, prepare} from '../stepbystep-protocol/run.mjs';
import {runArm, DEFAULT_LOCAL_TIER} from '../../symbolic-vs-llm/run.mjs';
import {openSession} from '../../lib/session.mjs';
import {rescore} from '../generality/run.mjs';
import {loadProtocol} from '../../../../lib/formalize/internal-reasoning/reasoner.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const strip = ({requires, ...rest}) => rest;
export const ARMS = Object.freeze({
  IR: {arm: 'B-stepbystep', strategy: 'InternalReasoningStepByStep', reasoningControl: 'plan'},
  'IR-greedy': {arm: 'B-stepbystep', strategy: 'InternalReasoningStepByStep', reasoningControl: 'greedy'},
  B: {arm: 'B-stepbystep', strategy: 'LocalLLMStepByStep', stepMethod: 'B'},
  GLM: {arm: 'C', strategy: 'LocalLLMStepByStep', stepMethod: 'B'},
});

/** Digest of the code an arm runs (a changed arm is a new run, never mixed into the same records). */
function digest(dirs) {
  const hash = createHash('sha256');
  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    const files = fs.statSync(full).isDirectory() ? fs.readdirSync(full).sort().map(f => path.join(full, f)) : [full];
    for (const f of files) if (fs.statSync(f).isFile()) hash.update(path.relative(ROOT, f)).update(fs.readFileSync(f));
  }
  return hash.digest('hex').slice(0, 16);
}

export async function main(args = process.argv.slice(2)) {
  const arms = opt(args, '--arms', 'IR,B').split(',');
  for (const a of arms) if (!ARMS[a]) throw new Error(`arms: ${Object.keys(ARMS).join(', ')}`);
  for (const gone of ['--endpoint', '--model']) if (args.includes(gone)) throw new Error(`${gone} is gone: every model call goes through Ploinky; name the tier with --local-tier (default ${DEFAULT_LOCAL_TIER})`);
  const localTier = opt(args, '--local-tier', DEFAULT_LOCAL_TIER);
  const levels = opt(args, '--levels', 'a,b,c,n').split(','), per = Number(opt(args, '--per', 3)), pool = opt(args, '--pool', 'measured');
  let rows = protocolRows({levels, per, pool});
  const ids = opt(args, '--ids', null)?.split(',');
  if (ids) rows = rows.filter(r => ids.includes(r.id));
  const sample = Number(opt(args, '--sample', 0));
  if (sample) rows = rows.map(r => ({r, k: createHash('sha256').update(`${opt(args, '--seed', 'tune')}/${r.id}`).digest('hex')})).sort((a, b) => a.k.localeCompare(b.k)).slice(0, sample).map(x => x.r);
  const limit = Number(opt(args, '--limit', 0));
  if (limit) rows = rows.slice(0, limit);
  const out = path.resolve(opt(args, '--out', path.join(ROOT, 'eval/reports/current/internal-reasoning/run')));
  fs.mkdirSync(out, {recursive: true});
  // One records file per arm: the local arms may run as parallel processes on the same Ploinky tier.
  const fileOf = arm => path.join(out, `records-${arm}.jsonl`);
  const done = new Set(arms.flatMap(arm => fs.existsSync(fileOf(arm)) ? fs.readFileSync(fileOf(arm), 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return `${r.id}/${r.method}`; }) : []));
  const protocol = loadProtocol();
  const code = {IR: digest(['lib/formalize/internal-reasoning', 'config/knowledge/formalizer-protocol-v1']), B: digest(['lib/query-author/step-by-step'])};
  const identity = {protocol: `${protocol.id}@${protocol.version}`, ir_sha: code.IR, b_sha: code.B, model: `tier:${localTier}`, local_tier: localTier, levels, per, pool, rows: rows.length, started: new Date().toISOString()};
  for (const arm of arms) {
    const run = path.join(out, `run-${arm}.json`);
    const key = arm.startsWith('IR') ? 'ir_sha' : ['B', 'GLM'].includes(arm) ? 'b_sha' : null;
    if (key && fs.existsSync(run) && JSON.parse(fs.readFileSync(run, 'utf8'))[key] !== identity[key] && !args.includes('--allow-changed')) throw new Error(`${arm}: the code changed since this run started; use a fresh --out`);
    if (!fs.existsSync(run)) fs.writeFileSync(run, JSON.stringify({...identity, arm}, null, 2) + '\n');
  }
  const settings = {model: identity.model, localTier, purpose: 'job:internal-reasoning-eval', wallMs: Number(opt(args, '--wall-ms', 180000)), maxTokens: Number(opt(args, '--max-tokens', 4096)), subscriptionModel: opt(args, '--glm-model', 'openference/Qwen3.8 27b'), tier: opt(args, '--tier', 'small')};
  let world1 = null;
  const shared = () => {
    if (!world1) {
      const session = openSession({base: 'world-v1', id: `internal-reasoning-${process.pid}`});
      const entry = session.store.get('qf', 'stepbystep', 'main');
      world1 = {chat: session, repo: session.store.repo, session: entry.agent.session, lexicon: session.lexicon,
        theory: session.theories.get([...session.sessions.baseCircuits(session.id), ...session.sessions.circuits(session.id)]), dispose: session.close};
    }
    return world1;
  };
  try {
    for (const row of rows) for (const arm of arms) {
      if (done.has(`${row.id}/${arm}`)) continue;
      let prepared;
      try { prepared = prepare(row, shared); } catch (error) { console.error(`${row.id} skipped: ${error.message}`); continue; }
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-reasoning-'));
      try {
        const {arm: harnessArm, ...extra} = ARMS[arm];
        const record = await runArm({row: {...row, family: row.form, expected: strip(prepared.expected)}, arm: harnessArm, world: prepared.world, gold: prepared.gold,
          slice: prepared.slice, evidence: prepared.evidence, knowledge: prepared.knowledge, query: prepared.query, settings: {...settings, ...extra}, folder});
        const outcome = row.level === 'a' ? record.outcome : rescore(row, record);
        const report = (() => { try { return JSON.parse(record.author?.plan ?? 'null'); } catch { return null; } })();
        const full = {...record, method: arm, level: row.level, form: row.form, question: row.question, pool, outcome_harness: record.outcome, outcome, expected: row.expected,
          questions: record.author?.steps?.length ?? 0, formalize_ms: record.latency?.parse_ms ?? null,
          ...(arm.startsWith('IR') ? {engine_ms: record.author?.engine_ms ?? null, decisions: report?.decisions ?? null, avoided: report?.avoided ?? null} : {})};
        fs.appendFileSync(fileOf(arm), JSON.stringify(full) + '\n');
        console.error(`${row.id} ${arm} ${outcome} q=${full.questions} ${full.formalize_ms}ms ${record.packet?.status ?? ''} ${record.author?.status ?? ''}${full.engine_ms != null ? ` engine=${full.engine_ms}ms/${full.decisions}` : ''}`);
      } finally {
        fs.rmSync(folder, {recursive: true, force: true});
        if (prepared.own) prepared.world.dispose();
      }
    }
  } finally { world1?.dispose(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
