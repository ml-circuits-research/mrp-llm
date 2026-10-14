// VENDORED: copied verbatim from soplab-v0.4.0.zip src/validate.mjs
import { collectVars } from './conditions.mjs';
import { isGroundAtom } from './model.mjs';
import { stratifyRules } from './stratify.mjs';

function varsInAtom(a) { return collectVars(a, new Set()); }
function diff(a, b) { return [...a].filter((x) => !b.has(x)); }

export function validateReasoner(reasoner) {
  const errors = [], warnings = [];

  for (const rec of reasoner.store.assertedValues()) {
    if (!isGroundAtom(rec.atom)) errors.push({ code: 'NON_GROUND_FACT', message: `Asserted fact must be ground: ${rec.key}` });
  }

  for (const r of reasoner.rules) {
    const headVars = varsInAtom(r.head);
    const bodyVars = collectVars(r.body, new Set());
    const missing = diff(headVars, bodyVars);
    if (missing.length) errors.push({ code: 'UNSAFE_RULE_HEAD', rule: r.id, variables: missing, message: `Rule ${r.id} has head variables absent from its body: ${missing.join(', ')}` });
  }

  for (const w of reasoner.wires.values()) {
    if (w.wireType === 'all' || w.wireType === 'any') {
      const bodyVars = collectVars(w.items, new Set());
      const missing = w.params.filter((p) => !bodyVars.has(p));
      if (missing.length) warnings.push({ code: 'WIRE_OUTPUT_NOT_REFERENCED', wire: w.id, variables: missing, message: `Wire ${w.id} outputs variables not referenced in its body: ${missing.join(', ')}` });
    }
    if (w.wireType === 'reduce') {
      const outputs = new Set([...w.groupBy, ...w.aggregates.map((a) => a.as)]);
      const missing = w.params.filter((p) => !outputs.has(p));
      if (missing.length) errors.push({ code: 'REDUCE_OUTPUT_UNDEFINED', wire: w.id, variables: missing, message: `Reduce wire ${w.id} has undefined outputs: ${missing.join(', ')}` });
    }
  }

  try { stratifyRules(reasoner, reasoner.rules); }
  catch (error) { errors.push({ code: 'NON_STRATIFIABLE', message: error.message }); }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertValidReasoner(reasoner) {
  const result = validateReasoner(reasoner);
  if (!result.ok) {
    const e = new Error(result.errors.map((x) => x.message).join('\n'));
    e.validation = result;
    throw e;
  }
  return result;
}
