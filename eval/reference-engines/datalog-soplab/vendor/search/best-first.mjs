// VENDORED: copied verbatim from soplab-v0.4.0.zip src/search/best-first.mjs
import { MinHeap } from './heap.mjs';

export function bestFirstSearch({ initial, isGoal, expand, key = JSON.stringify, heuristic = () => 0, maxExpansions = 100000 }) {
  const open = new MinHeap((a, b) => a.priority - b.priority || a.cost - b.cost);
  const best = new Map();
  const k0 = key(initial);
  open.push({ state: initial, cost: 0, priority: heuristic(initial), path: [] });
  best.set(k0, 0);
  let expansions = 0;
  while (open.size && expansions < maxExpansions) {
    const node = open.pop();
    const nk = key(node.state);
    if (node.cost !== best.get(nk)) continue;
    if (isGoal(node.state, node)) return { found: true, ...node, expansions };
    expansions++;
    for (const edge of expand(node.state, node)) {
      const cost = node.cost + (edge.cost ?? 1);
      const ek = key(edge.state);
      if (best.has(ek) && best.get(ek) <= cost) continue;
      best.set(ek, cost);
      open.push({ state: edge.state, cost, priority: cost + heuristic(edge.state), path: [...node.path, edge.action ?? null] });
    }
  }
  return { found: false, expansions, exhausted: open.size === 0 };
}
