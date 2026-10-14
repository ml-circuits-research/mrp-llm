/**
 * Sink of jobs/formalization-improve: the regression gate (tools/eval/formalization/regression/gate.mjs) for every checked proposal, in
 * order, each on top of what was admitted before it. A proposal is admitted (appended to config/knowledge/formalizer-learned-v1 and
 * the baseline extended) only if it fixes cases of its cluster and loses none on tier tiny. What the gate refuses, and every
 * `ESCALATE:` reply, goes to the run's escalations.jsonl for the Claude-level improver; every verdict to gate.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import {gate} from '../../tools/eval/formalization/regression/gate.mjs';

const append = (file, row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');

export async function sink({accepted, items, run, dir}) {
  const out = {admitted: [], refused: [], escalated: []};
  for (const r of accepted) {
    const item = items.get(r.id)?.data ?? items.get(r.id) ?? {};
    const value = r.value ?? {};
    if (value.escalate) {
      append(path.join(dir, 'escalations.jsonl'), {id: r.id, kind: 'missing_construct', cluster: item.cluster, reason: value.escalate, cases: item.case_ids, at: new Date().toISOString()});
      out.escalated.push(r.id);
      continue;
    }
    let verdict;
    try { verdict = gate({wires: value.sop, cases: item.case_ids ?? [], tag: `${run}-${r.id}`.replace(/[^\w-]+/g, '_'), admit: true, note: `jobs/formalization-improve run ${run}, cluster ${item.cluster}`, log: m => console.error(m)}); }
    catch (e) { verdict = {admitted: false, reason: `gate error: ${e.message}`}; }
    append(path.join(dir, 'gate.jsonl'), {id: r.id, cluster: item.cluster, proposal: value.sop, ...verdict, at: new Date().toISOString()});
    if (verdict.admitted) out.admitted.push(r.id);
    else {
      out.refused.push(r.id);
      append(path.join(dir, 'escalations.jsonl'), {id: r.id, kind: 'gate_refused', cluster: item.cluster, reason: verdict.reason, proposal: value.sop, fixed: verdict.fixed, lost: verdict.lost, cases: item.case_ids, at: new Date().toISOString()});
    }
  }
  return {...out, summary: `gate: admitted ${out.admitted.length}, refused ${out.refused.length}, escalated ${out.escalated.length}`};
}
