/**
 * The deterministic route of a problem from the structure role's output (owner decision 2026-10-03, proposal P-6): a problem goes to
 * the jsEval route (lib/formalize/js-program.mjs) when
 *   - the structure role found what the question asks: a `goal` span inside a question unit (a sentence ending with `?`, else the
 *     last sentence), and
 *   - the problem has registry quantities: at least one registry number (lib/formalize/registry.mjs) lies inside a `quantity` span,
 *     so the goal is computed from given data;
 * every other problem (puzzles, deductions and rule questions without data, a problem whose goal the structure role did not find)
 * stays on the FOL route (lib/formalize/fol). The decision reads only labels, offsets and digits (./to-ir.mjs); no word of the problem
 * is interpreted.
 */
import {structureToIr} from './to-ir.mjs';

export const ROUTES = Object.freeze(['js', 'fol']);

/** {route, goal, quantities, numbers, reason} for a structure extraction (the JSON of the structure tier) of a problem text. */
export function routeOf(extraction, text) {
  if (!extraction || extraction.error) return {route: 'fol', goal: false, quantities: 0, numbers: 0, reason: 'no structure'};
  const s = structureToIr(extraction, String(text ?? ''));
  const goal = s.goals.some(g => g.inQuestion), quantities = s.numbers.filter(n => n.quantity).length;
  const route = goal && quantities > 0 ? 'js' : 'fol';
  const reason = route === 'js' ? 'a goal in the question and registry quantities' : !goal ? 'no goal span in a question unit' : 'no registry number inside a quantity span';
  return {route, goal, quantities, numbers: s.numbers.length, reason};
}
