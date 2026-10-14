/**
 * why_not: why is the claim NOT derivable? The answer is the minimal sets of base (EDB) atoms, over the vocabulary of the slice and
 * respecting the declared argument types, whose ADDITION would make the claim derivable, plus the blocking atoms (the atoms that
 * satisfy a `not`, an `except` or a strict contrary and so block an otherwise matching rule instance). This is abduction with a
 * restricted hypothesis space, not an unsat core.
 *
 * Definition used (the proposal says "minimal"; the precise reading is fixed here):
 *   - the claim is a ground conjunction; a literal already derivable costs nothing;
 *   - a missing literal is explained either by adding it (when its predicate is base: not the head of any rule, or it has stored
 *     facts) or by a rule whose head matches it, recursively, never through a literal already being explained (cycles are cut);
 *   - a body atom with variables is matched against the evidence that EXISTS first; only when nothing matches are its variables
 *     grounded over the constants of the slice (so the nearest explanation is returned, not every fantasy instance);
 *   - an `absent`, a `not` or a compare that fails cannot be repaired by adding facts: that instance is dead and, for `absent`,
 *     the atom that holds is reported as a blocker;
 *   - the returned sets are inclusion-minimal, smallest first.
 */
import {atomText, argsKey, groundArgs, isVarTerm} from './values.mjs';
import {unify} from './join.mjs';
import {explainOf} from './support.mjs';
import {compareValues, compute, orderValues, termIn} from './values.mjs';

const MAX_ALTERNATIVES = 2000;

export function whyNot({program, ev, goalAlts, budget, limit = Infinity}) {
  const derived = new Set([...program.rules.map(r => r.head.p), ...program.aggregates.map(a => a.yields.p)]);
  const hasFacts = new Set(program.facts.map(f => f.p));
  const abducible = p => !p.startsWith('x_') && (!derived.has(p) || hasFacts.has(p));
  const headRules = new Map();
  for (const r of program.rules) for (const alt of r.alts) {
    const k = `${r.head.neg}|${r.head.p}`;
    if (!headRules.has(k)) headRules.set(k, []);
    headRules.get(k).push({rule: r, alt});
  }
  const constants = new Set();
  for (const f of program.facts) f.args.forEach(a => constants.add(a));
  for (const r of program.rules) for (const t of r.head.args) if (!isVarTerm(t)) constants.add(t);
  const domainFor = (p, i) => {
    const type = program.predicates.get(p)?.args[i]?.type;
    return [...constants].filter(c => (type === 'integer' ? typeof c === 'number' : type === 'entity' || type === 'text' ? typeof c === 'string' : true));
  };
  const blockers = new Map();
  const noteBlocker = (neg, p, args, why) => {
    const node = ev.get(neg, p, args);
    if (!node) return;
    const k = `${why}|${neg}|${p}|${argsKey(args)}`;
    if (!blockers.has(k)) blockers.set(k, {atom: atomText(neg, p, args), why, support: explainOf([node]).uses});
  };

  const merge = (as, bs) => {
    const out = [];
    for (const a of as) for (const b of bs) {
      if (out.length >= MAX_ALTERNATIVES) budget.fail('maxCandidates');
      out.push({adds: new Set([...a.adds, ...b.adds])});
    }
    return out;
  };

  const explainLiteral = (neg, p, args, path) => {
    budget.node();
    const key = `${neg}|${p}|${argsKey(args)}`;
    if (path.has(key)) return [];
    if (ev.get(neg, p, args)) return [{adds: new Set()}];
    const results = [];
    if (abducible(p)) {
      results.push({adds: new Set([atomText(neg, p, args)])});
      noteBlocker(!neg, p, args, 'contradicts');
    }
    const inner = new Set([...path, key]);
    for (const {rule, alt} of headRules.get(`${neg}|${p}`) ?? []) {
      const env = unify(rule.head.args, args, {});
      if (!env) continue;
      results.push(...solveBody(alt.leaves, 0, env, inner));
    }
    return results;
  };

  const solveBody = (leaves, i, env, path) => {
    if (i === leaves.length) return [{adds: new Set()}];
    const l = leaves[i];
    const next = e2 => solveBody(leaves, i + 1, e2, path);
    switch (l.kind) {
      case 'compare': return compareValues(l.word, termIn(l.left, env), termIn(l.right, env)) ? next(env) : [];
      case 'order': return orderValues(l.word, env[l.left], env[l.right]) ? next(env) : [];
      case 'compute': {
        const v = compute(l.word, termIn(l.left, env), termIn(l.right, env));
        return v === undefined ? [] : next({...env, [l.out]: v});
      }
      case 'timeof': return []; // the validity of a stored fact cannot be repaired by adding a fact
      case 'atom': {
        const g = groundArgs(l.args, env);
        if (l.mode === 'absent') {
          if (ev.get(false, l.p, g)) { noteBlocker(false, l.p, g, 'absent_fails'); return []; }
          return next(env);
        }
        const neg = l.mode === 'not';
        if (g) return merge(explainLiteral(neg, l.p, g, path), next(env));
        const out = [];
        const matches = ev.list(neg, l.p).map(n => unify(l.args, n.args, env)).filter(Boolean);
        if (matches.length) { for (const e2 of matches) out.push(...next(e2)); return out; }
        const free = [...new Set(l.args.filter(isVarTerm).filter(t => !(t.var in env)).map(t => t.var))];
        const assignments = free.reduce((acc, v) => {
          const idx = l.args.findIndex(t => isVarTerm(t) && t.var === v);
          const dom = domainFor(l.p, idx);
          return acc.flatMap(a => dom.map(c => ({...a, [v]: c})));
        }, [{}]);
        for (const a of assignments) {
          const e2 = {...env, ...a};
          out.push(...merge(explainLiteral(neg, l.p, groundArgs(l.args, e2), path), next(e2)));
        }
        return out;
      }
      default: return [];
    }
  };

  const all = goalAlts.flatMap(alt => solveBody(alt.leaves, 0, {}, new Set()));
  const sets = [...new Map(all.map(a => [[...a.adds].sort().join('\u0000'), [...a.adds].sort()])).values()];
  const minimal = sets.filter(s => !sets.some(o => o !== s && o.length < s.length && o.every(x => s.includes(x))))
    .sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1));
  return {missing: minimal.slice(0, limit), blockers: [...blockers.values()], ...(minimal.length > limit ? {truncated: true} : {})};
}

