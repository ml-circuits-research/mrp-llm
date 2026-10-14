/**
 * Native search for a recognised closure: one breadth-first search from the bound argument over the adjacency of the edge relation,
 * parent pointers for a witness path. A step costs one probe of the budget (an edge examined), the unit `maxJoins` counts.
 */
export function adjacency(facts) {
  const fwd = new Map(), bwd = new Map();
  const put = (m, k, e) => { let l = m.get(k); if (!l) m.set(k, l = []); l.push(e); };
  for (const f of facts) {
    put(fwd, f.args[0], {to: f.args[1], fact: f.claim.id});
    put(bwd, f.args[1], {to: f.args[0], fact: f.claim.id});
  }
  return {fwd, bwd};
}

/**
 * Nodes reachable from `start` by one or more edges. Returns {depth: Map(node -> steps), parent: Map(node -> {from, fact}), probes}
 * (`cut` is true when `maxLevels` BFS levels were not enough: a round ceiling, one level per fixpoint round) or {stop: 'probes'} when more than `maxProbes` edges would be examined. `start` itself appears only if a cycle returns to it.
 */
export function reach(adj, start, maxProbes = Infinity, maxLevels = Infinity) {
  const depth = new Map(), parent = new Map();
  let frontier = [start], d = 0, probes = 0;
  let cut = false;
  while (frontier.length) {
    if (d >= maxLevels) { cut = true; break; }
    d++;
    const next = [];
    for (const u of frontier) {
      for (const e of adj.get(u) ?? []) {
        if (++probes > maxProbes) return {stop: 'probes', probes};
        if (depth.has(e.to)) continue;
        depth.set(e.to, d);
        parent.set(e.to, {from: u, fact: e.fact});
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return {depth, parent, probes, cut};
}

/** The nodes of the witness path start -> target (start first), following parent pointers; null when unreachable. */
export function pathTo(res, start, target) {
  if (!res.depth.has(target)) return null;
  const nodes = [target], facts = [];
  for (let cur = target; ;) {
    const p = res.parent.get(cur);
    facts.push(p.fact);
    nodes.push(p.from);
    if (p.from === start) break;
    cur = p.from;
  }
  return {nodes: nodes.reverse(), facts: facts.reverse()};
}
