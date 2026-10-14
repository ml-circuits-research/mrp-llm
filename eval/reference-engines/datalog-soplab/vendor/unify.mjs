// VENDORED: copied verbatim from soplab-v0.4.0.zip src/unify.mjs
import { cloneBindings, isVar, substituteTerm } from './model.mjs';

export function unifyTerms(a, b, bindings = {}) {
  const out = cloneBindings(bindings);
  return unifyInto(a, b, out) ? out : null;
}

function unifyInto(a0, b0, bindings) {
  const a = substituteTerm(a0, bindings);
  const b = substituteTerm(b0, bindings);

  if (Object.is(a, b)) return true;
  if (isVar(a)) { bindings[a] = b; return true; }
  if (isVar(b)) { bindings[b] = a; return true; }

  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) if (!unifyInto(a[i], b[i], bindings)) return false;
    return true;
  }

  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    for (const k of ak) if (!unifyInto(a[k], b[k], bindings)) return false;
    return true;
  }
  return false;
}

export function unifyAtoms(pattern, value, bindings = {}) {
  if (pattern.pred !== value.pred) return null;
  if ((pattern.sign ?? 1) !== (value.sign ?? 1)) return null;
  if (pattern.args.length !== value.args.length) return null;
  let out = cloneBindings(bindings);
  for (let i = 0; i < pattern.args.length; i++) {
    out = unifyTerms(pattern.args[i], value.args[i], out);
    if (!out) return null;
  }
  return out;
}
