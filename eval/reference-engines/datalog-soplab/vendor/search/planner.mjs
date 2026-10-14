// VENDORED: copied verbatim from soplab-v0.4.0.zip src/search/planner.mjs
import { Reasoner } from '../reasoner.mjs';
import { atomKey, isGroundAtom, substituteAtom, substituteTerm } from '../model.mjs';
import { bestFirstSearch } from './best-first.mjs';

function stateKey(state) { return [...state.keys()].sort().join('|'); }
function toState(facts) {
  const m = new Map();
  for (const f of facts) { if (!isGroundAtom(f)) throw new Error('Planner initial facts must be ground'); m.set(atomKey(f), f); }
  return m;
}

function reasonerForState(template, state, rules) {
  const r = new Reasoner({
    builtins: template?.builtins, providers: template?.providers,
    wireTypes: template?.wireTypes, materializers: template?.materializers,
  });
  if (template) { r.wires = new Map(template.wires); }
  r.facts([...state.values()]).addRules(rules ?? []);
  r.saturate({ strategy: 'delta' });
  return r;
}

export function plan({ initialFacts, goals, transitions, rules = [], template = null, maxExpansions = 50000, heuristic = () => 0 }) {
  const initial = toState(initialFacts);
  return bestFirstSearch({
    initial, key: stateKey, maxExpansions, heuristic,
    isGoal: (state) => reasonerForState(template, state, rules).query(goals).length > 0,
    expand: (state) => {
      const r = reasonerForState(template, state, rules);
      const edges = [];
      for (const op of transitions) {
        for (const sol of r.query(op.when ?? [])) {
          const b = sol.bindings;
          const add = (op.add ?? []).map((x) => substituteAtom(x, b));
          const remove = (op.remove ?? []).map((x) => substituteAtom(x, b));
          if (![...add, ...remove].every(isGroundAtom)) continue;
          const next = new Map(state);
          remove.forEach((x) => next.delete(atomKey(x)));
          add.forEach((x) => next.set(atomKey(x), x));
          edges.push({
            state: next, cost: op.cost ?? 1,
            action: { transition: op.id, bindings: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, substituteTerm(v, b)])), add, remove },
          });
        }
      }
      return edges;
    },
  });
}
