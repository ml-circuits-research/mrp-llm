// VENDORED: copied verbatim from soplab-v0.4.0.zip src/wire-types.mjs
import { cloneBindings, substituteTerm } from './model.mjs';
import { instantiateWire, stripLocalBindings } from './conditions.mjs';
import { unifyTerms } from './unify.mjs';

function aggregateValue(op, values, count) {
  if (op === 'count') return count;
  if (op === 'sum') return values.reduce((a, b) => a + b, 0);
  if (op === 'min') return values.length ? values.reduce((a, b) => a < b ? a : b) : undefined;
  if (op === 'max') return values.length ? values.reduce((a, b) => a > b ? a : b) : undefined;
  if (op === 'collect') return values;
  if (op === 'set') return [...new Set(values)];
  if (op === 'first') return values[0];
  throw new Error(`Unknown aggregate: ${op}`);
}

/** Handler for `all` and `any` view wires. */
export function* logicalWireHandler({ def, args, seed, evidence, context, solve }) {
  const callArgs = args.map((x) => substituteTerm(x, seed));
  const { expr, localPrefix } = instantiateWire(def, callArgs);
  for (const sol of solve(expr, seed, evidence, context)) {
    yield { bindings: stripLocalBindings(sol.bindings, localPrefix), evidence: sol.evidence };
  }
}

/** Handler for aggregate/reduction wires. */
export function* reduceWireHandler({ def, args, seed, evidence, context, solve }) {
  const callArgs = args.map((x) => substituteTerm(x, seed));
  const inst = instantiateWire(def, callArgs);
  const rows = [...solve(inst.source, seed, evidence, context)];
  const groups = new Map();

  for (const row of rows) {
    const groupValues = inst.groupBy.map((term) => substituteTerm(term, row.bindings));
    const key = JSON.stringify(groupValues);
    if (!groups.has(key)) groups.set(key, { groupValues, rows: [] });
    groups.get(key).rows.push(row);
  }
  if (!inst.groupBy.length && !groups.size) groups.set('[]', { groupValues: [], rows: [] });

  for (const group of groups.values()) {
    let b = cloneBindings(seed);
    let ok = true;
    for (let i = 0; i < inst.groupBy.length; i++) {
      b = unifyTerms(inst.groupBy[i], group.groupValues[i], b);
      if (!b) { ok = false; break; }
    }
    if (!ok) continue;

    for (const spec of inst.aggregates) {
      const values = spec.field == null ? [] : group.rows.map((r) => substituteTerm(spec.field, r.bindings));
      b = unifyTerms(spec.as, aggregateValue(spec.op, values, group.rows.length), b);
      if (!b) { ok = false; break; }
    }
    if (!ok) continue;

    const ev = group.rows.flatMap((r) => r.evidence);
    yield { bindings: stripLocalBindings(b, inst.localPrefix), evidence: [...evidence, ...ev] };
  }
}

export function defaultWireTypes() {
  return new Map([
    ['all', logicalWireHandler],
    ['any', logicalWireHandler],
    ['reduce', reduceWireHandler],
  ]);
}
