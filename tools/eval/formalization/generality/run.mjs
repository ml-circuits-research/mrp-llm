#!/usr/bin/env node
/**
 * Generality probe (experiment eval-generality-v1; AGENTS.md direction 7): level b held-out forms, level c compositions
 * and free natural questions on world-v1. Every arm goes through the symbolic-vs-llm harness `runArm` unchanged:
 *   C  the step-by-step formalizer with its questions answered by the Ploinky tier --tier (default small; LLMDirect one-shot authoring
 *      is archived since 2026-10-02), then admission, KnowledgeLinker resolution and the engine;
 *   R  zero-model replay of the reviewed model-surface circuit of the row (`reference`) through the same admission and
 *      execution: it separates "the language/engine cannot" from "the author did not";
 *   D  the same remote model answering from the evidence rendered as English (arm A of the benchmark plan);
 *   B  the step-by-step formalizer on the local Ploinky tier --local-tier (default micro; arm B-stepbystep).
 *   node tools/eval/formalization/generality/run.mjs --arms C,R --levels b,c,n [--tier small] [--local-tier micro] [--per 5] [--only form] [--ids a,b] [--out dir]
 * Dev data only: generated memories and the approved world-v1 base memory; no sealed suite is read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generalityCases} from '../../../datasets/diversity/generality.mjs';
import {runArm, evidenceFor, DEFAULT_LOCAL_TIER} from '../../symbolic-vs-llm/run.mjs';
import {createWorld, execute, goldSlice} from '../../symbolic-vs-llm/world.mjs';
import {score} from '../../symbolic-vs-llm/score.mjs';
import {verifyAnswer} from '../../../../reasoning/strategies/js-reference/index.mjs';
import {parse} from '../../../../sop/knowledge/lexical.mjs';
import {renderEnglish} from '../../../../reasoning/slice/render-english.mjs';
import {openSession} from '../../lib/session.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const NATURAL_FILE = path.join(ROOT, 'tools/eval/formalization/generality/natural-v1.jsonl');
const HONEST = new Set(['unknown', 'incomplete', 'clarify', 'unclear', 'not_computable', 'not_expressible', 'unsupported', 'relation_not_in_memory']);
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const strip = ({requires, ...rest}) => rest;

export function naturalRows(file = NATURAL_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .map(r => ({...r, level: 'n', form: r.form ?? 'natural', split: 'dev', base_memory: 'world-v1', facts: 357515, depth: 1}));
}

/**
 * Final outcome. A supposition's id is chosen by whoever writes the circuit, so a conditional answer is compared by its
 * number of assumptions. A question world-v1 cannot answer is correct only as an honest non-answer.
 */
export function rescore(row, record) {
  const packet = record.packet;
  // A compound natural question with an answerable part is judged by hand from the rendered answer (gold_note).
  if (row.expected.manual) return ['invalid', 'failed'].includes(record.outcome) ? record.outcome : 'manual';
  if (row.expected.unavailable) {
    if (record.outcome === 'invalid' || record.outcome === 'failed') return record.outcome;
    const status = packet?.status, unclear = record.author?.status === 'validated' && /unclear/.test(record.author?.sop ?? '') && !/@\w+ query/.test(record.author?.sop ?? '');
    if (!packet || HONEST.has(status) || unclear || packet.complete === false) return 'correct';
    return 'wrong';
  }
  // A direct answer (arm D) has no assumption ids to report; its verdict under the supposition is compared by status.
  if (row.expected.conditional && record.arm === 'D' && packet) return score(strip({...row.expected, conditional: undefined}), {...packet, conditional: undefined}, {}).outcome;
  if (!row.expected.conditional || !packet?.conditional?.length || record.outcome === 'invalid' || record.outcome === 'failed') return record.outcome;
  const ids = Array.isArray(packet.conditional) ? packet.conditional : [packet.conditional];
  const normalized = {...packet, conditional: ids.length === row.expected.conditional.length ? row.expected.conditional : ids};
  return score(strip(row.expected), normalized, {}).outcome;
}

function goldOf(row, world) {
  if (row.base_memory === 'world-v1') {
    if (row.expected.unavailable || row.expected.manual) {
      const packet = row.evidence_query ? execute(world, row.evidence_query) : {status: 'unknown', complete: true};
      return {gold: packet, query: row.evidence_query ?? null};
    }
    return {gold: execute(world, row.query), query: row.query};
  }
  const gold = verifyAnswer({theory: {knowledge: row.knowledge + (row.gold_defs ?? '')}, query: row.query});
  return {gold, query: row.query};
}

export async function main(args = process.argv.slice(2)) {
  const arms = opt(args, '--arms', 'C,R').split(',');
  if (arms.some(a => !['C', 'R', 'D', 'B'].includes(a))) throw new Error('arms: C, R, D, B');
  const levels = opt(args, '--levels', 'b,c,n').split(',');
  const per = Number(opt(args, '--per', 5));
  const ids = opt(args, '--ids', null)?.split(',');
  let rows = [...(levels.some(l => ['b', 'c'].includes(l)) ? generalityCases({per}).filter(r => levels.includes(r.level)) : []), ...(levels.includes('n') ? naturalRows() : [])];
  if (opt(args, '--only', null)) rows = rows.filter(r => r.form === opt(args, '--only'));
  if (ids) rows = rows.filter(r => ids.includes(r.id));
  for (const gone of ['--endpoint', '--model']) if (args.includes(gone)) throw new Error(`${gone} is gone: every model call goes through Ploinky; name the local tier with --local-tier (default ${DEFAULT_LOCAL_TIER})`);
  const localTier = opt(args, '--local-tier', DEFAULT_LOCAL_TIER);
  const settings = {model: `tier:${localTier}`, localTier, purpose: 'job:generality-eval', subscriptionModel: opt(args, '--subscription-model', 'openference/Qwen3.8 27b'), tier: opt(args, '--tier', 'small'),
    wallMs: Number(opt(args, '--wall-ms', 180000)), maxTokens: Number(opt(args, '--max-tokens', 4096))};
  if (/^openrouter\b/.test(settings.subscriptionModel) && !args.includes('--allow-paid')) throw new Error('openrouter is paid per token; pass --allow-paid for an explicitly authorized run');
  const out = path.resolve(opt(args, '--out', path.join(ROOT, 'eval/reports/current/generality/records')));
  fs.mkdirSync(out, {recursive: true});
  const file = path.join(out, 'records.jsonl');
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return `${r.id}/${r.arm}`; }) : []);
  let shared = null;
  try {
    for (const row of rows) {
      const todo = arms.filter(a => !done.has(`${row.id}/${a}`) && !(a === 'R' && !row.reference));
      if (!todo.length) continue;
      let world;
      if (row.base_memory === 'world-v1') {
        if (!shared) {
          const session = openSession({base: 'world-v1', id: `generality-${process.pid}`});
          const entry = session.store.get('qf', 'generality', 'main');
          shared = {chat: session, repo: session.store.repo, session: entry.agent.session, lexicon: session.lexicon,
            theory: session.theories.get([...session.sessions.baseCircuits(session.id), ...session.sessions.circuits(session.id)]), dispose: session.close};
        }
        world = shared;
      } else world = createWorld(row.knowledge);
      try {
        const {gold, query} = goldOf(row, world);
        if (!row.expected.unavailable && !row.expected.manual) {
          const check = score(strip(row.expected), row.expected.conditional ? {...gold, conditional: row.expected.conditional} : gold).outcome;
          if (check !== 'correct' && !(row.expected.status === 'refuted' && gold.status === 'unknown')) throw new Error(`${row.id}: gold circuit disagrees with the constructed answer (${gold.status})`);
        }
        let slice, evidence;
        if (row.base_memory === 'world-v1') {
          slice = query ? goldSlice(world, query, gold) : {facts: [], wires: []};
          evidence = query ? evidenceFor(slice, row.question) : {source: '(no evidence was retrieved)', evidence_does_not_fit: false, facts: 0, original_chars: 0};
        } else {
          slice = {facts: [], wires: parse(row.knowledge).wires};
          const source = renderEnglish(row.knowledge);
          evidence = {source, evidence_does_not_fit: false, facts: (row.knowledge.match(/^@f\S* fact$/gm) ?? []).length, original_chars: source.length};
        }
        for (const arm of todo) {
          const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'generality-author-'));
          try {
            const armSettings = arm === 'R' ? {...settings, replayCircuit: row.reference} : settings;
            const record = await runArm({row: {...row, family: row.form, expected: strip(row.expected)}, arm: arm === 'R' ? 'C' : arm === 'B' ? 'B-stepbystep' : arm, world, gold, slice, evidence,
              knowledge: row.knowledge ?? '', query: query ?? '@q query\n  where unknown_relation ?x\n  select ?x\n', settings: armSettings, folder});
            const outcome = rescore(row, record);
            const full = {...record, arm, model: arm === 'R' ? 'reviewed-circuit' : record.model, level: row.level, form: row.form, question: row.question,
              outcome_harness: record.outcome, outcome, expected: row.expected};
            fs.appendFileSync(file, JSON.stringify(full) + '\n');
            console.error(`${row.id} ${arm} ${outcome}${outcome !== record.outcome ? ` (harness ${record.outcome})` : ''} ${record.latency.wall_ms}ms ${record.packet?.status ?? ''} ${record.failure_layer ?? ''}`);
          } finally { fs.rmSync(folder, {recursive: true, force: true}); }
        }
      } finally { if (world !== shared) world.dispose(); }
    }
  } finally { shared?.dispose(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
