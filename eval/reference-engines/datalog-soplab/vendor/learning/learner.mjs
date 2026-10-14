// VENDORED: copied verbatim from soplab-v0.4.0.zip src/learning/learner.mjs
import { Reasoner } from '../reasoner.mjs';
import { atom } from '../model.mjs';

export function scoreRule(candidate, worlds, {
  target = 'target',
  positiveWeight = 1,
  negativeWeight = 1,
  complexityPenalty = 0.001,
} = {}) {
  let correct = 0, totalWeight = 0, tp = 0, tn = 0, fp = 0, fn = 0;
  for (const world of worlds) {
    const r = new Reasoner();
    r.facts(world.facts).addRule(candidate).saturate({ strategy: 'delta' });
    for (const [x, y] of world.positives ?? []) {
      const supported = r.ask(atom(target, x, y)).status === 'supported';
      totalWeight += positiveWeight;
      if (supported) { correct += positiveWeight; tp++; } else fn++;
    }
    for (const [x, y] of world.negatives ?? []) {
      const supported = r.ask(atom(target, x, y)).status === 'supported';
      totalWeight += negativeWeight;
      if (!supported) { correct += negativeWeight; tn++; } else fp++;
    }
  }
  const accuracy = totalWeight ? correct / totalWeight : 0;
  const complexity = candidate.meta?.complexity ?? (Array.isArray(candidate.body) ? candidate.body.length : 1);
  return { rule: candidate, correct, totalWeight, accuracy, complexity, score: accuracy - complexityPenalty * complexity, confusion: { tp, tn, fp, fn } };
}

export function rankRules(candidates, worlds, options = {}) {
  return candidates.map((r) => scoreRule(r, worlds, options)).sort((a, b) =>
    b.score - a.score || b.accuracy - a.accuracy || a.complexity - b.complexity || a.rule.id.localeCompare(b.rule.id));
}
