/**
 * The trace of InternalReasoningStepByStep (DS022 "InternalReasoningStepByStep"): one entry per decision of the controller, with the
 * open slots and violations the oracle selected, the plan it found (or why it found none), the chosen question, the derivation that
 * made that question askable (from the oracle's proof), the model's answer and the facts the answer established. `explainTrace`
 * renders it as short English lines (what a reviewer or a judge reads to see why each question was asked).
 */
const short = (rows, n = 8) => rows.slice(0, n).map(r => r.join(' '));

export function traceEntry({step, decision, action = null, arg = null, outcome = null, added = [], asked = []}) {
  return {
    step, control: decision.control, kind: decision.kind, ...(decision.reason ? {reason: decision.reason} : {}),
    open: short(decision.open ?? []), violations: short(decision.violations ?? []), askable: short(decision.askable ?? []),
    plan: decision.plan ?? null, plan_cost: decision.cost ?? null, expanded: decision.expanded ?? null,
    chosen: action ? `${action} ${arg}`.trim() : null, why: (decision.why ?? []).slice(0, 10),
    asked: asked.map(s => ({name: s.name, answer: s.answer, ms: s.ms})), outcome, added: added.slice(0, 16),
    engine_ms: Math.round(((decision.ms?.closure ?? 0) + (decision.ms?.plan ?? 0)) * 10) / 10,
  };
}

/** A readable account of the decisions: why each question was asked, what it established, and how the formalization ended. */
export function explainTrace(trace, {fallback = null, defaults = []} = {}) {
  const lines = [];
  for (const e of trace) {
    if (e.kind === 'done') { lines.push(`Step ${e.step}: the goal "formalized" holds; nothing is left to ask.`); continue; }
    if (e.kind === 'stuck') { lines.push(`Step ${e.step}: no question can complete the circuit (${e.reason ?? 'no plan'}); open: ${e.open.join('; ') || 'none'}; violations: ${e.violations.join('; ') || 'none'}.`); continue; }
    const head = `Step ${e.step}: ${e.chosen} (${e.control}${e.plan ? `; plan ${e.plan.join(' → ')}, cost ${e.plan_cost}` : ''}).`;
    const why = e.why.length ? ` Askable because: ${e.why.map(l => l.trim()).join(' | ')}.` : '';
    const open = e.open.length ? ` Open: ${e.open.join('; ')}.` : '';
    const violations = e.violations.length ? ` Violations: ${e.violations.join('; ')}.` : '';
    const answer = e.asked.length ? ` Asked ${e.asked.map(a => `${a.name} → ${JSON.stringify(a.answer)}`).join(', ')}.` : ' No model call.';
    const outcome = e.outcome ? ` ${e.outcome}` : '';
    const added = e.added.length ? ` Established: ${e.added.join('; ')}.` : '';
    lines.push(head + open + violations + why + answer + outcome + added);
  }
  if (defaults.length) lines.push(`Settled by defaults (no question): ${defaults.map(d => `${d.atom} (${d.default})`).join('; ')}.`);
  if (fallback) lines.push(`The assembled circuit was refused (${fallback.problems.join(', ')}); the answer is an honest "relation not in memory".`);
  return lines.join('\n');
}
