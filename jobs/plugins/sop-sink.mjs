/**
 * Job-runner sink plugin of ChatSOP (Ploinky Workers jobs): stores the accepted SOP programs of a run into the task's target through the existing store path
 * (no manual approval, owner 2026-10-02; the knowledge validator runs again there):
 *   target {kind: "memory", id}   BaseMemories.addKnowledge (all circuits at once; on a validation failure, one by one)
 *   target {kind: "session", id}  Sessions.addCircuit per accepted item (origin "llm_job")
 * The stores come from `ctx.memories` / `ctx.sessions` (the server passes its own) or are opened from the default chat data root.
 */
import {ChatData, chatDataSettings} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {Sessions} from '../../lib/chat-data/sessions.mjs';

const textOf = r => r.output?.sop ?? r.output?.text ?? '';

export async function sink({accepted, run, spec}, ctx = {}) {
  const target = ctx.target ?? {kind: 'none'};
  const circuits = accepted.filter(r => textOf(r).trim()).map(r => ({name: `${spec.name}-${r.id}`, text: textOf(r)}));
  if (target.kind === 'none' || !circuits.length) return {stored: 0, summary: `nothing stored (target ${target.kind}, ${circuits.length} programs)`};
  const chatData = ctx.chatData ?? new ChatData(chatDataSettings({}));
  const memories = ctx.memories ?? new BaseMemories({chatData});
  const source = {kind: 'llm-job', job: spec.name, run};
  if (target.kind === 'memory') {
    try {
      const r = memories.addKnowledge(target.id, {circuits, approvedBy: 'llm-jobs', reason: `job ${spec.name} run ${run}`, source});
      return {stored: r.added.length, summary: `stored ${r.added.length} circuits in base memory ${target.id}`};
    } catch (e) {
      let stored = 0;
      const failed = [];
      for (const c of circuits) {
        try { memories.addKnowledge(target.id, {circuits: [c], approvedBy: 'llm-jobs', reason: `job ${spec.name} run ${run}`, source}); stored += 1; }
        catch (err) { failed.push({name: c.name, error: err.message}); }
      }
      return {stored, failed, summary: `stored ${stored}/${circuits.length} circuits in base memory ${target.id} (${failed.length} refused by the validator against the memory)`};
    }
  }
  if (target.kind === 'session') {
    const sessions = ctx.sessions ?? new Sessions({chatData, memories});
    let stored = 0;
    const failed = [];
    for (const c of circuits) {
      try { sessions.addCircuit(target.id, {name: c.name, text: c.text, origin: 'llm_job', by: 'llm-jobs'}); stored += 1; }
      catch (err) { failed.push({name: c.name, error: err.message}); }
    }
    return {stored, failed, summary: `stored ${stored}/${circuits.length} circuits in session ${target.id}`};
  }
  throw new Error(`unknown target kind ${target.kind}`);
}
