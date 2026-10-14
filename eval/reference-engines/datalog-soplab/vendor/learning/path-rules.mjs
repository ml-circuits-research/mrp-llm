// VENDORED: copied verbatim from soplab-v0.4.0.zip src/learning/path-rules.mjs
import { atom, rule } from '../model.mjs';

function cartesian(items, length, prefix = []) {
  if (length === 0) return [prefix];
  const out = [];
  for (const item of items) out.push(...cartesian(items, length - 1, [...prefix, item]));
  return out;
}

export function generatePathRules({ relations, target = 'target', maxBody = 3, includeInverse = true }) {
  const variants = relations.flatMap((pred) => includeInverse ? [{ pred, inverse: false }, { pred, inverse: true }] : [{ pred, inverse: false }]);
  const out = [];
  for (let len = 1; len <= maxBody; len++) {
    for (const seq of cartesian(variants, len)) {
      const vars = ['?x', ...Array.from({ length: len - 1 }, (_, i) => `?z${i + 1}`), '?y'];
      const body = seq.map((r, i) => r.inverse ? atom(r.pred, vars[i + 1], vars[i]) : atom(r.pred, vars[i], vars[i + 1]));
      const id = `path:${seq.map((x) => `${x.inverse ? '~' : ''}${x.pred}`).join('/')}`;
      out.push(rule(id, atom(target, '?x', '?y'), body, { generated: true, complexity: len }));
    }
  }
  return out;
}
