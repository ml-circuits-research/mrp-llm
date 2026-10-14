/**
 * The chat reply of an adapter answer in the modes `routed` and `direct-verified`: the answer packet becomes turn facts
 * (cv_turn_verification, cv_turn_answer_source, cv_turn_alternatives) and slots (verified_by, model_answer, alternatives), and the
 * conversation layer (config/knowledge/conversation-v1/0080-verification.sop) chooses the body that shows the verification status.
 * The code holds no phrasing: slot values are the answer, path names and values. Structure only.
 */
const list = xs => xs.filter(x => x !== null && x !== undefined && x !== '').join(', ');
const shown = v => (Array.isArray(v) ? v.map(shown).join(', ') : typeof v === 'boolean' ? String(v) : String(v));

/** The turn facts of an answer packet's verification. */
export function verificationFacts(answer) {
  const v = answer.verification ?? {};
  const facts = [`cv_turn_verification ${v.status ?? 'unresolved'}`];
  if (answer.path) facts.push(`cv_turn_answer_source ${answer.path === 'direct' ? 'model' : 'formalized'}`);
  if (v.alternatives?.length) facts.push('cv_turn_alternatives');
  return facts;
}

/** The slots of an answer packet's verification. */
export function verificationSlots(answer) {
  const v = answer.verification ?? {};
  return {
    verified_by: list((v.paths ?? []).filter(p => p !== 'direct')) || undefined,
    model_answer: v.model_answer ?? answer.direct?.text ?? undefined,
    alternatives: v.alternatives?.length ? list(v.alternatives.map(a => `${shown(a.values)} (${a.path})`)) : undefined,
  };
}

/**
 * The chat output of an adapter answer through the agent's reply composition (server/agent.mjs `reply`): {text, packet}, the packet
 * being the answering path's result packet (or a minimal one for a direct or missing answer) with `adapter` (the answer packet
 * without the runtime packet).
 */
export function adapterReply(agent, answer, {text = '', now = Date.now()} = {}) {
  const {packet: runtimePacket, ...summary} = answer;
  const base = answer.path && answer.path !== 'direct' && runtimePacket ? {...runtimePacket} : {status: answer.path === 'direct' ? 'direct_answer' : 'not_answered', complete: false};
  delete base.reply; delete base.answer_text;
  const packet = {...base, adapter: summary};
  const output = {kind: 'cnl', language: 'en', text: answer.answer?.text ?? null, packet};
  return agent.reply(output, {text, now, facts: verificationFacts(answer), slots: verificationSlots(answer)});
}
