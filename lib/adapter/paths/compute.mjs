/**
 * The compute paths of ChatSOPAdapter for a problem whose goal is computed from given data (the route of
 * lib/formalize/structure/route.mjs):
 *   B       the closed question of lib/formalize/expression-program.mjs (`name = expression` lines over v1..vn, prompt variant a, no
 *           exemplars: the same question for every model), its static analysis (the answer must reach the problem's numbers through
 *           the dataflow) and lowering to SOP; every query of the lowered circuit runs on the engines on its own.
 *   jsEval  the role prompt config/prompts/js-v1.md (lib/formalize/js-program.mjs): admitted jsEval wires, lowered to the
 *           engines' circuit where their shape allows, otherwise run by the oracle (the trusted runtime's jsEval interpreter).
 * Both are formalizations by a model of the same problem over the same registry numbers; they never answer, the engines do.
 */
import {registryOf, expressionFormalize} from '../../formalize/expression-program.mjs';
import {jsFormalize, runOracle} from '../../formalize/js-program.mjs';
import {executeQueries} from '../../formalize/dual-check.mjs';
import {packetValues} from '../executor.mjs';
import {allCached} from '../clients.mjs';
import {pathResult} from './result.mjs';

/** Runs every query of a lowered circuit on its own: {answers: [{kind: 'value', value, status}], packets}. */
export async function executeCircuit(sop, registry, executor) {
  const packets = [];
  const qs = await executeQueries(sop, async text => {
    const p = await executor.run(text, registry.map(v => v.value));
    packets.push(p);
    return {status: p.status, values: packetValues(p)};
  });
  return {answers: qs.map(q => ({kind: 'value', value: q.values.length ? q.values[0] : null, status: q.status})), packets, queries: qs};
}

/** Path B on a message: {path: 'B', ...}. `chat` is a tier client (./clients.mjs tierChat). */
export async function pathB({message, chat, executor, registry = null, exemplars = [], lexicon = null}) {
  const t0 = performance.now();
  registry ??= registryOf(message);
  const e = await expressionFormalize({message, chat, exemplars, registry, lexicon});
  const detail = {status: e.status, attempts: e.attempts.map(a => ({answer: a.answer, reason: a.reason, violations: a.violations})), program: e.analysis?.program?.answers ?? null};
  const base = {tier: chat.tier ?? null, calls: chat.calls, cached: allCached(chat)};
  if (e.status !== 'ok' || !e.lowered?.sop) return pathResult('B', {...base, status: e.status === 'ok' ? 'error' : e.status, ms: Math.round(performance.now() - t0), detail});
  const x = await executeCircuit(e.lowered.sop, registry, executor);
  return pathResult('B', {...base, status: 'ok', answers: x.answers, circuits: [e.lowered.sop], packets: x.packets, ms: Math.round(performance.now() - t0), detail: {...detail, sop: e.lowered.sop}});
}

const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a)) : a === b);
const flat = answers => answers.flatMap(a => (Array.isArray(a.value) ? a.value.flat(Infinity).map(value => ({kind: 'value', value})) : [{kind: 'value', value: a.value}]));

/**
 * Executes an admitted jsEval program: the oracle's answers always; the engines' answers when it was lowered (then `agree` says
 * whether the engines gave the oracle's values). Returns {answers, executed: 'engines'|'oracle', agree, packets, sop}.
 */
export async function executeJs(admitted, lowering, registry, executor) {
  const oracle = flat((await runOracle(admitted, registry)).answers);
  if (!lowering?.lowered) return {answers: oracle, executed: 'oracle', agree: null, packets: [], sop: null};
  const x = await executeCircuit(lowering.sop, registry, executor);
  const answers = x.answers.map(a => ({kind: 'value', value: a.value, status: a.status}));
  return {answers, executed: 'engines', agree: answers.length === oracle.length && answers.every((a, k) => same(a.value, oracle[k].value)), packets: x.packets, sop: lowering.sop};
}

/** The jsEval route on a message: {path: 'jsEval', ...}. */
export async function pathJsEval({message, chat, executor, registry = null, lexicon = null}) {
  const t0 = performance.now();
  registry ??= registryOf(message);
  const r = await jsFormalize({message, chat, registry, lexicon});
  const detail = {status: r.status, attempts: r.attempts, wires: r.admitted?.wires?.map(w => ({id: w.id, expr: w.expr})) ?? null, answers: r.admitted?.answers ?? null, values: r.admitted?.values ?? null,
    lowered: r.lowering?.lowered ?? false, why: r.lowering?.why ?? null};
  const base = {tier: chat.tier ?? null, calls: chat.calls, cached: allCached(chat)};
  if (r.status !== 'ok') return pathResult('jsEval', {...base, status: r.status, ms: Math.round(performance.now() - t0), detail});
  const x = await executeJs(r.admitted, r.lowering, registry, executor);
  return pathResult('jsEval', {...base, status: 'ok', answers: x.answers, circuits: x.sop ? [x.sop] : [], packets: x.packets, ms: Math.round(performance.now() - t0),
    detail: {...detail, executed: x.executed, agree: x.agree, sop: x.sop}});
}
