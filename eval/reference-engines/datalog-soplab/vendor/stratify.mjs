// VENDORED: copied verbatim from soplab-v0.4.0.zip src/stratify.mjs
import { isRef } from './conditions.mjs';

function predKey(a) { return `${a.sign === -1 ? -1 : 1}:${a.pred}/${a.args.length}`; }

export function collectDependencies(expr, reasoner, out = [], { negative = false, seenWires = new Set() } = {}) {
  if (!expr) return out;
  if (Array.isArray(expr)) { for (const x of expr) collectDependencies(x, reasoner, out, { negative, seenWires }); return out; }
  if (expr.pred) { out.push({ predicate: predKey(expr), negative }); return out; }
  if (isRef(expr)) {
    const marker = `${expr.ref}:${negative ? 'N' : 'P'}`;
    if (seenWires.has(marker)) return out;
    seenWires.add(marker);
    const wire = reasoner.wires.get(expr.ref);
    if (!wire) return out;
    if (wire.wireType === 'reduce') collectDependencies(wire.source, reasoner, out, { negative, seenWires });
    else if (wire.items) collectDependencies(wire.items, reasoner, out, { negative, seenWires });
    else if (wire.dependencies) collectDependencies(wire.dependencies, reasoner, out, { negative, seenWires });
    return out;
  }
  if (expr.op === 'none') {
    collectDependencies(expr.item, reasoner, out, { negative: !negative, seenWires });
    return out;
  }
  if (expr.op === 'all' || expr.op === 'any') {
    for (const x of expr.items ?? []) collectDependencies(x, reasoner, out, { negative, seenWires });
  }
  return out;
}

export function stratifyRules(reasoner, rules = reasoner.rules) {
  const predicates = new Set();
  const rows = rules.map((r) => {
    const head = predKey(r.head);
    predicates.add(head);
    const dependencies = collectDependencies(r.body, reasoner);
    dependencies.forEach((d) => predicates.add(d.predicate));
    return { rule: r, head, dependencies };
  });
  const strata = new Map([...predicates].map((p) => [p, 0]));
  const maxPasses = Math.max(1, predicates.size + 1);
  let changed = false;
  for (let pass = 0; pass < maxPasses; pass++) {
    changed = false;
    for (const row of rows) {
      for (const dep of row.dependencies) {
        const needed = (strata.get(dep.predicate) ?? 0) + (dep.negative ? 1 : 0);
        if ((strata.get(row.head) ?? 0) < needed) {
          strata.set(row.head, needed);
          changed = true;
        }
      }
    }
    if (!changed) break;
    if (pass === maxPasses - 1) {
      const negativeEdges = rows.flatMap((x) => x.dependencies.filter((d) => d.negative).map((d) => `${x.head} -NONE-> ${d.predicate}`));
      throw new Error(`Program is not stratifiable: negative dependency cycle detected. ${negativeEdges.join('; ')}`);
    }
  }
  const groups = new Map();
  for (const row of rows) {
    const s = strata.get(row.head) ?? 0;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(row.rule);
  }
  return {
    strata,
    groups: [...groups.entries()].sort(([a], [b]) => a - b).map(([stratum, groupedRules]) => ({ stratum, rules: groupedRules })),
  };
}
