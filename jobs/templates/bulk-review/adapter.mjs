/**
 * Adapter of the bulk-review template: wraps lib/llm-review (review -> second opinion -> repair -> validator -> re-review) with the
 * auditor tier, through the task's Ploinky Workers client; escalations.jsonl lands in the task folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import {loadKind, reviewLoop, chat} from '../../../lib/llm-review/index.mjs';
import {validateProgram} from '../../../sop/knowledge/index.mjs';

const check = (item, work) => {
  try {
    const problems = validateProgram([{name: 'work.sop', text: work, role: 'knowledge'}], {authoring: true}).problems.filter(p => p.severity !== 'warning').map(p => `${p.code}: ${p.message}`);
    return {ok: !problems.length, problems};
  } catch (e) { return {ok: false, problems: [e.message]}; }
};

export async function run({params, attachments, taskDir, config, ta}) {
  let items = attachments.flatMap(a => fs.readFileSync(a.path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)));
  if (params.limit) items = items.slice(0, params.limit);
  const kind = loadKind(params.review_kind);
  const tier = config.roles.auditor;
  // The task's Ploinky Workers client (tagged with the task's purpose and run, so its budget applies) carries every call.
  const call = ({system, user}) => chat({tier, system, user, clientName: 'job-bulk-review', maxTokens: kind.defaults?.maxTokens ?? 16000,
    reasoning: kind.defaults?.reasoning ?? 'low', ta, noFallback: false});
  const r = await reviewLoop({items, kind, call, check: kind.check?.validator === 'sop-knowledge' ? check : undefined, budgetTokens: kind.defaults?.budgetTokens ?? 20000, repair: params.repair !== false});
  fs.writeFileSync(path.join(taskDir, 'escalations.jsonl'), r.escalations.map(e => JSON.stringify(e)).join('\n') + (r.escalations.length ? '\n' : ''));
  fs.writeFileSync(path.join(taskDir, 'repaired.jsonl'), r.repaired.map(e => JSON.stringify(e)).join('\n') + (r.repaired.length ? '\n' : ''));
  const t = r.ledger.total();
  return {status: 'finished', summary: `reviewed ${r.items}: flagged ${r.flagged.length}, confirmed ${r.confirmed.length}, repaired ${r.repaired.length}, escalated ${r.escalations.length}; ${t.calls} calls, ${t.usd.toFixed(4)} USD`};
}
