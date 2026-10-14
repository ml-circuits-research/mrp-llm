// VENDORED: copied verbatim from soplab-v0.4.0.zip src/dependency.mjs
import { isRef } from './conditions.mjs';

export function collectPredicates(expr, reasoner, out = new Set(), seenWires = new Set()) {
  if (!expr) return out;
  if (Array.isArray(expr)) { expr.forEach((x) => collectPredicates(x, reasoner, out, seenWires)); return out; }
  if (expr.pred) { out.add(`${expr.sign === -1 ? -1 : 1}:${expr.pred}/${expr.args.length}`); return out; }
  if (isRef(expr)) {
    if (seenWires.has(expr.ref)) return out;
    seenWires.add(expr.ref);
    const wire = reasoner.wires.get(expr.ref);
    if (!wire) return out;
    if (wire.wireType === 'reduce') collectPredicates(wire.source, reasoner, out, seenWires);
    else if (wire.items) collectPredicates(wire.items, reasoner, out, seenWires);
    else if (wire.dependencies) collectPredicates(wire.dependencies, reasoner, out, seenWires);
    return out;
  }
  if (expr.op === 'none') return collectPredicates(expr.item, reasoner, out, seenWires);
  if (expr.op === 'all' || expr.op === 'any') expr.items.forEach((x) => collectPredicates(x, reasoner, out, seenWires));
  return out;
}

export function sliceRules(reasoner, goalExpr) {
  const needed = collectPredicates(goalExpr, reasoner);
  const selected = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of reasoner.rules) {
      const hk = `${r.head.sign === -1 ? -1 : 1}:${r.head.pred}/${r.head.args.length}`;
      if (!needed.has(hk) || selected.has(r.id)) continue;
      selected.add(r.id);
      for (const dep of collectPredicates(r.body, reasoner)) {
        if (!needed.has(dep)) { needed.add(dep); changed = true; }
      }
    }
  }
  return {
    rules: reasoner.rules.filter((r) => selected.has(r.id)),
    predicates: needed,
  };
}

export function dependencyGraph(reasoner) {
  const nodes = [];
  for (const r of reasoner.rules) {
    nodes.push({
      rule: r.id,
      head: `${r.head.sign === -1 ? 'NOT ' : ''}${r.head.pred}/${r.head.args.length}`,
      dependsOn: [...collectPredicates(r.body, reasoner)].sort(),
    });
  }
  return nodes;
}
