#!/usr/bin/env node
/**
 * Replay of recorded InternalReasoningStepByStep answers (DS022 "InternalReasoningStepByStep"): every IR record of an evaluation run
 * (records-IR*.jsonl of tools/eval/formalization/internal-reasoning/run.mjs) is formalized again with the current protocol memory and code, the model
 * replaced by the recorded answers in their order. A row whose circuit changes is reported with the first question that differs, so a
 * change of the protocol (a new question, a new default) can be checked without a model call. With --debug the last decision's open
 * slots, askable questions and violations are printed.
 *   node tools/formalizer-protocol/replay.mjs --run eval/reports/current/internal-reasoning/stage1 [--ids x,y] [--debug] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {protocolRows, prepare} from '../eval/formalization/stepbystep-protocol/run.mjs';
import {openSession} from '../eval/lib/session.mjs';
import {internalReasoningQuery, createReasoningOracle, loadProtocol} from '../../lib/formalize/internal-reasoning/index.mjs';

const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

/** A chat that answers with the recorded answers in order (the extra questions of a changed protocol get "0"). */
export function replayChat(answers) {
  let k = 0;
  const asked = [];
  const chat = async messages => { asked.push(messages.at(-1).content); const text = k < answers.length ? answers[k++] : '0'; return {ok: true, text, ms: 0, usage: {input_tokens: 0, output_tokens: 0}, cached: 0, evaluated: 0}; };
  return {chat, asked};
}

export async function replay({records, rows, protocol = loadProtocol(), debug = false}) {
  let world1 = null;
  const shared = () => {
    if (!world1) {
      const session = openSession({base: 'world-v1', id: `ir-replay-${process.pid}`});
      const entry = session.store.get('qf', 'stepbystep', 'main');
      world1 = {repo: session.sessions.repository(session.id), session: entry.agent.session, lexicon: session.lexicon,
        theory: session.theories.get([...session.sessions.baseCircuits(session.id), ...session.sessions.circuits(session.id)]), dispose: session.close};
    }
    return world1;
  };
  const out = [];
  try {
    for (const record of records) {
      const row = rows.get(record.id);
      if (!row) { out.push({id: record.id, skipped: 'row not in the protocol rows'}); continue; }
      const prepared = prepare(row, shared);
      try {
        const answers = (record.author?.steps ?? []).map(s => s.answer);
        const {chat} = replayChat(answers);
        const world = prepared.world;
        const r = await internalReasoningQuery({message: row.question, lexicon: world.lexicon, repo: world.repo, session: world.session, derived: new Set(world.theory.byHead?.keys?.() ?? []),
          oracle: createReasoningOracle({chat, protocol}), protocol, control: record.method === 'IR-greedy' ? 'greedy' : 'plan'});
        const before = record.author?.sop ?? '', names = (record.author?.steps ?? []).map(s => s.name), now = r.steps.map(s => s.name);
        const first = names.findIndex((n, i) => n !== now[i]);
        out.push({id: record.id, same: r.sop === before, status: r.status, questions: r.steps.length, recorded: names.length,
          first_difference: first >= 0 ? {at: first, recorded: names[first], now: now[first] ?? null} : now.length > names.length ? {at: names.length, recorded: null, now: now[names.length]} : null,
          sop: r.sop, ...(debug ? {explanation: r.explanation.split('\n').slice(-3), last: r.trace.at(-1)} : {})});
      } finally { if (prepared.own) prepared.world.dispose(); }
    }
  } finally { world1?.dispose(); }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = path.resolve(opt(args, '--run', 'eval/reports/current/internal-reasoning/stage1'));
  const ids = opt(args, '--ids', null)?.split(',');
  const records = fs.readdirSync(dir).filter(f => /^records-IR.*\.jsonl$/.test(f)).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse))
    .filter(r => !ids || ids.includes(r.id));
  const pools = [...new Set(records.map(r => r.pool ?? 'measured'))];
  const rows = new Map(pools.flatMap(pool => protocolRows({levels: ['a', 'b', 'c', 'n'], per: 15, pool})).map(r => [r.id, r]));
  const out = await replay({records, rows, debug: args.includes('--debug')});
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else for (const o of out) console.log(`${o.id}: ${o.skipped ?? `${o.same ? 'same' : 'CHANGED'} ${o.status} q=${o.questions}/${o.recorded}${o.first_difference ? ` first difference at ${o.first_difference.at}: ${o.first_difference.recorded} -> ${o.first_difference.now}` : ''}`}${o.explanation ? '\n  ' + o.explanation.join('\n  ') + '\n  last: ' + JSON.stringify({open: o.last.open, askable: o.last.askable, violations: o.last.violations}) : ''}`);
}
