/**
 * The acceptance rule for a learned artefact (proposal 5.6): re-certify on load, replay positive witnesses in the original rules,
 * run in shadow against the reference on small tasks, revoke on any disagreement. A learned part may only choose among legal plans;
 * it never decides an answer (E10's rule). Here the reference is the wrapped strategy run WITHOUT the skill on the same circuits.
 */
import {NotExpressibleError} from '../js-reference/values.mjs';

const rowKey = r => JSON.stringify(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
const rowSet = p => new Set((p.rows ?? []).map(rowKey));

/** Probes of a packet in the wrapped engine's own units (never compared across engines, DS005) plus rounds, E10's score. */
export const PROBE_KEYS = ['maxJoins', 'probes'];
export function score(packet, roundWeight = 32) {
  const u = packet?.budget?.used ?? {};
  const probes = u.maxJoins ?? u.probes ?? packet?.retrieval?.probes ?? 0;
  return probes + roundWeight * (u.maxRounds ?? 0);
}
export const probesOf = packet => packet?.budget?.used?.maxJoins ?? packet?.budget?.used?.probes ?? packet?.retrieval?.probes ?? 0;

/** Same answer: status, completeness, rows as a set, count, bound, conditional list; never the proof or the probe counters. */
export function sameAnswer(a, b) {
  const why = [];
  if (a.status !== b.status) why.push(`status ${a.status} against ${b.status}`);
  if ((a.complete ?? true) !== (b.complete ?? true)) why.push('complete differs');
  const ra = rowSet(a), rb = rowSet(b);
  if (ra.size !== rb.size || [...ra].some(k => !rb.has(k))) why.push('rows differ');
  if (a.count !== b.count) why.push(`count ${a.count} against ${b.count}`);
  if ((a.bound ?? null) !== (b.bound ?? null)) why.push('bound differs');
  if (JSON.stringify([...(a.conditional ?? [])].sort()) !== JSON.stringify([...(b.conditional ?? [])].sort())) why.push('conditional differs');
  return {ok: !why.length, why};
}

/**
 * Shadow-certify a rewriting on stored tasks. `run(task, rewritten)` asks the wrapped strategy; a task the strategy cannot express is
 * not evidence. Returns {verified, tasks, referenceScore, candidateScore, ms: {reference, candidate}, disagreement?}.
 * A budget-limited reference (incomplete) is not exact evidence either: it is skipped, never counted as agreement.
 */
export function certify(run, tasks, {roundWeight = 32} = {}) {
  let used = 0, referenceScore = 0, candidateScore = 0, refMs = 0, candMs = 0;
  for (const task of tasks) {
    let ref, cand;
    try {
      let t = performance.now();
      ref = run(task, false); refMs += performance.now() - t;
      t = performance.now();
      cand = run(task, true); candMs += performance.now() - t;
    } catch (e) {
      if (e instanceof NotExpressibleError) continue;
      return {verified: false, tasks: used, disagreement: {task: task.id, why: [`error: ${e.message}`]}};
    }
    if (ref.complete === false) continue;
    used++;
    const same = sameAnswer(ref, cand);
    if (!same.ok) return {verified: false, tasks: used, disagreement: {task: task.id, why: same.why}};
    referenceScore += score(ref, roundWeight); candidateScore += score(cand, roundWeight);
  }
  return {verified: used > 0, tasks: used, referenceScore, candidateScore, ms: {reference: Math.round(refMs), candidate: Math.round(candMs)}, ...(used ? {} : {disagreement: {why: ['no exact evidence']}})};
}
