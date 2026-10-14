// VENDORED: copied verbatim from soplab-v0.4.0.zip src/workflows.mjs
import { Reasoner } from './reasoner.mjs';
import { loadSOP } from './parser.mjs';
import { plan } from './search/planner.mjs';
import { abduct } from './search/abduction.mjs';

export function reasonerFromParsed(parsed, reasoner = new Reasoner()) {
  return loadSOP(reasoner, parsed);
}

export function planParsed(parsed, { goalIndex = 0, maxExpansions = 50000 } = {}) {
  const template = reasonerFromParsed(parsed);
  const goal = parsed.goals[goalIndex];
  if (!goal) throw new Error('No goal available for planning');
  return plan({
    initialFacts: parsed.facts.map((x) => x.atom),
    goals: goal.where,
    transitions: parsed.transitions,
    rules: parsed.rules,
    template,
    maxExpansions,
  });
}

export function abductParsed(parsed, { goalIndex = 0, ...options } = {}) {
  const r = reasonerFromParsed(parsed);
  const goal = parsed.goals[goalIndex];
  if (!goal) throw new Error('No goal available for abduction');
  return abduct(r, goal.where, parsed.assumptions, options);
}
