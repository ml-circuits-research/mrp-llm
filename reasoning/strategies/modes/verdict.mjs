/** The packet of a conformance verdict (proposal 8.4): shared by the planner's monitors and by the core lowering, so both answer in one shape. */
export function conformPacket(ctx, verdict) {
  const out = {
    status: verdict.compliant ? 'compliant' : 'non_compliant', complete: true, compliance: verdict.compliance, used: verdict.used,
    violations: verdict.violations, deviations: verdict.deviations
  };
  if (verdict.triggered.length) out.obligations_triggered = verdict.triggered;
  if (verdict.unscoped.length) { out.obligation_unscoped = verdict.unscoped; out.notes = verdict.unscoped.map(id => `obligation_unscoped ${id}`); }
  if (verdict.infeasible.length) out.infeasible = verdict.infeasible;
  if (verdict.goalMissed) out.notes = [...(out.notes ?? []), 'goal_not_reached'];
  if (verdict.relaxedDeviations?.length) out.relaxed = verdict.relaxedDeviations;
  if (verdict.compliance.relaxed) out.relaxed = verdict.compliance.relaxed;
  return out;
}
