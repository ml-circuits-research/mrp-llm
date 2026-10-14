/**
 * Shadow lowering of a numeric-action plan (extension E2) to GROUND STRIPS for the oracle: the reachable states of the ORIGINAL laws
 * (no compression) up to a depth are enumerated, each becomes a node `s<i>`, each guarded transition a unit-cost action, and the goal
 * nodes derive `solved`. `js-oracle` then plans by uniform cost over that graph, which checks the breadth-first search with merging and
 * the plan cost of the strategy against an independent search. Honest limit: the transitions are computed by the same exact
 * arithmetic (the vendored exact evaluator), so this checks the SEARCH, not the arithmetic; the strategy replays every plan in the
 * original laws and the arithmetic is covered by the rational tests.
 */
import {readProgram, buildModel} from '../../../reasoning/strategies/vrc-compressed-planning/model.mjs';
import {makeRuntime} from '../../../reasoning/strategies/vrc-compressed-planning/search.mjs';
import {compileExactPolynomials, exactRelation} from '../../../reasoning/strategies/vrc-compressed-planning/vendor/exact-runtime.mjs';

export function lowerToStrips(knowledge, query, {maxNodes = 5000} = {}) {
  const model = buildModel(readProgram(knowledge, 'knowledge'), readProgram(query, 'query'));
  const horizon = Math.min(model.horizon ?? 20, 64);
  const rt = makeRuntime(model);
  const key = (l, z) => [...l].sort().join(';') + '#' + z.map(String).join(',');
  const logicStep = (set, a) => {
    for (const r of a.requires) if (r.neg ? set.has(r.key) : !set.has(r.key)) return null;
    const n = new Set(set);
    for (const r of a.removes) n.delete(r.key);
    for (const x of a.adds) n.add(x.key);
    return n;
  };
  const nodes = [{logic: model.logic, z: rt.encode(model.initial)}], index = new Map([[key(model.logic, nodes[0].z), 0]]), edges = [];
  let frontier = [0];
  for (let d = 0; d < horizon && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      model.actions.forEach((a, k) => {
        const l = logicStep(nodes[i].logic, a);
        if (!l) return;
        const z = rt.advance(nodes[i].z, k);
        if (!z) return;
        const kk = key(l, z);
        let j = index.get(kk);
        if (j === undefined) { j = nodes.length; if (j >= maxNodes) throw new Error('numeric-strips: too many states'); nodes.push({logic: l, z}); index.set(kk, j); next.push(j); }
        edges.push([i, j, a.id]);
      });
    }
    frontier = next;
  }
  const truncated = frontier.length > 0;
  const holds = n => model.goal.atoms.every(a => (a.neg ? !n.logic.has(a.key) : n.logic.has(a.key))) && exactRelation(model.goal.op, rt.observe(n.z).sub(model.goal.threshold));
  let text = '@at predicate\n  args subject:entity\n@goalnode predicate\n  args subject:entity\n@solved predicate\n  args none\n';
  text += `@i0 fact\n  holds at s0\n`;
  nodes.forEach((n, i) => { if (holds(n)) text += `@g${i} fact\n  holds goalnode s${i}\n`; });
  text += '@r_solved rule\n  when at ?s\n  when goalnode ?s\n  then solved\n';
  const seen = new Set();
  edges.forEach(([i, j, id]) => {
    const k = `${i}_${j}`;
    if (seen.has(k)) return;
    seen.add(k);
    text += `@t_${k} action\n  requires at s${i}\n  removes at s${i}\n  adds at s${j}\n  cost 1\n`;
  });
  return {knowledge: text, query: `@q query\n  mode plan\n  where solved\n  policy $p\n@p policy\n  maxDepth ${horizon}\n  maxNodes 200000\n`, nodes: nodes.length, truncated, horizon};
}
