/**
 * Nested-loop evaluation of an ordered conjunction of leaves over the evidence tables (deliberately simple: one pass per leaf; the key
 * lookup of a ground atom, and for an atom with a bound position a hash index on that position, built lazily and extended as the table
 * grows, so a join of two large relations costs the matching pairs, not their product). Every candidate examined costs one probe of
 * the budget (`maxJoins`).
 *
 * Leaves: a positive atom (P), `not` (N), `absent` (no P; only over a closed predicate, checked at compile time),
 * `compare`, `compute`, `order`, `start_of`/`end_of` over the stored facts of the time view.
 */
import {isVarTerm, groundArgs, termIn, compareValues, orderValues, compute} from './values.mjs';

/** Extend `env` so that `args` equals `values`; null on a mismatch. */
export function unify(args, values, env) {
  if (args.length !== values.length) return null;
  let out = env;
  for (let k = 0; k < args.length; k++) {
    const a = args[k], v = values[k];
    if (isVarTerm(a)) {
      if (a.var in out) { if (out[a.var] !== v) return null; } else {
        if (out === env) out = {...env};
        out[a.var] = v;
      }
    } else if (a !== v) return null;
  }
  return out;
}

/** Below this many rows a table is scanned, not indexed. */
const INDEX_AT = 24;

/**
 * The rows of the table (`neg`, `p`) that can unify with `args` under `env`: all rows, or the bucket of the first bound position when the
 * table is large. The index is a Map per (table, position) kept in `ctx.joinIndex`; it covers the rows added since the last call.
 */
function candidates(ctx, neg, p, args, env) {
  const list = ctx.ev.list(neg, p);
  if (list.length < INDEX_AT) return list;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const bound = isVarTerm(a) ? (a.var in env ? env[a.var] : undefined) : a;
    if (bound === undefined) continue;
    const indexes = ctx.joinIndex ??= new Map();
    const key = (neg ? 'n' : 'p') + '|' + p + '|' + k;
    let index = indexes.get(key);
    if (!index || index.list !== list) { index = {list, built: 0, map: new Map()}; indexes.set(key, index); }
    for (; index.built < list.length; index.built++) {
      const row = list[index.built], value = row.args[k];
      const bucket = index.map.get(value);
      if (bucket) bucket.push(row); else index.map.set(value, [row]);
    }
    return index.map.get(bound) ?? [];
  }
  return list;
}

/** Generator of {env, prem}; `ctx` = {ev, stored, budget, notes}. */
export function* join(leaves, i, env, prem, ctx) {
  if (i === leaves.length) { yield {env, prem}; return; }
  const l = leaves[i];
  const {ev, budget} = ctx;
  switch (l.kind) {
    case 'atom': {
      if (l.mode === 'absent') {
        const g = groundArgs(l.args, env);
        budget.probe();
        if (!ev.get(false, l.p, g)) yield* join(leaves, i + 1, env, [...prem, {absent: {p: l.p, args: g}}], ctx);
        return;
      }
      const neg = l.mode === 'not';
      const g = groundArgs(l.args, env);
      if (g) {
        budget.probe();
        const n = ev.get(neg, l.p, g);
        if (n) yield* join(leaves, i + 1, env, [...prem, n], ctx);
        return;
      }
      for (const n of candidates(ctx, neg, l.p, l.args, env)) {
        budget.probe();
        const e2 = unify(l.args, n.args, env);
        if (e2) yield* join(leaves, i + 1, e2, [...prem, n], ctx);
      }
      return;
    }
    case 'compare':
      if (compareValues(l.word, termIn(l.left, env), termIn(l.right, env))) yield* join(leaves, i + 1, env, prem, ctx);
      return;
    case 'compute': {
      const v = compute(l.word, termIn(l.left, env), termIn(l.right, env));
      if (v === undefined) { ctx.notes.add('arithmetic_undefined'); return; }
      if (l.out in env) { if (env[l.out] === v) yield* join(leaves, i + 1, env, prem, ctx); return; }
      yield* join(leaves, i + 1, {...env, [l.out]: v}, prem, ctx);
      return;
    }
    case 'order':
      if (orderValues(l.word, env[l.left], env[l.right])) yield* join(leaves, i + 1, env, prem, ctx);
      return;
    case 'timeof': {
      for (const f of ctx.stored.get(l.p) ?? []) {
        if (f.neg) continue;
        budget.probe();
        const e2 = unify(l.args, f.args, env);
        if (!e2) continue;
        const t = l.which === 'start_of' ? (f.valid?.fromText ?? 'beginning') : (f.valid?.toText ?? 'open');
        const e3 = l.out in e2 ? (e2[l.out] === t ? e2 : null) : {...e2, [l.out]: t};
        // the premise is THE stored fact whose validity was read (several stored facts may share one tuple), not the first of the tuple
        const node = {neg: false, p: f.p, args: f.args, kind: 'fact', ref: f.claim, factId: f.id, premises: [], status: f.status, speaker: f.speaker};
        if (e3) yield* join(leaves, i + 1, e3, [...prem, node], ctx);
      }
      return;
    }
    default: throw new Error('unknown leaf ' + l.kind);
  }
}
