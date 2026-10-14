// VENDORED: copied verbatim from soplab-v0.4.0.zip src/search/abduction.mjs
import { atomKey } from '../model.mjs';
import { MinHeap } from './heap.mjs';

function key(items) { return items.map((x) => atomKey(x.atom)).sort().join('|'); }

export function abduct(reasoner, goals, assumptions, {
  maxAssumptions = 4,
  maxExpansions = 10000,
  scope = 'sliced',
  strategy = 'delta',
} = {}) {
  const candidates = assumptions.map((x, i) => x.atom ? { cost: 1, ...x, index: i } : { atom: x, cost: 1, index: i });
  const open = new MinHeap((a, b) => a.cost - b.cost || a.items.length - b.items.length);
  const seen = new Set();
  open.push({ items: [], next: 0, cost: 0 });
  let expansions = 0;

  while (open.size && expansions++ < maxExpansions) {
    const node = open.pop();
    const k = key(node.items);
    if (seen.has(k)) continue;
    seen.add(k);
    const r = reasoner.clone({ includeDerived: false, resetMetrics: true });
    for (const a of node.items) r.fact(a.atom, { kind: 'assumption', id: a.id ?? a.label ?? null, cost: a.cost });
    const evalResult = r.evaluate(goals, { scope, strategy });
    if (evalResult.rows.length) return { found: true, cost: node.cost, assumptions: node.items, answers: evalResult.rows, expansions, metrics: evalResult.metrics };
    if (node.items.length >= maxAssumptions) continue;
    for (let i = node.next; i < candidates.length; i++) {
      const c = candidates[i];
      open.push({ items: [...node.items, c], next: i + 1, cost: node.cost + c.cost });
    }
  }
  return { found: false, expansions };
}
