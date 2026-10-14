/**
 * A select, exists or count query pushed INTO the Soufflé program, so that the engine (and its optional magic-set transformation)
 * decides what to compute and only the answer rows are read back, not whole relations.
 *
 * Added relations (all over the variables of the query's `projection`):
 *   x_q_rows(proj)    every derivation of the `where` part, one clause per alternative;
 *   x_q_clean(proj)   the derivations whose literals have no opposite evidence (no `n_p` for a positive literal, no `p_p` for a `not`
 *                     literal): a row is `both` exactly when it has derivations and none of them is clean (the oracle's rule);
 *   x_q_ref_A_L()     nullary flags of the refutation test of the oracle (`leafRefuted`) for literal L of alternative A, read only when no
 *                     row exists: a ground positive literal with negative evidence, a positive literal of a closed predicate that
 *                     matches no positive row, a ground `not`/`absent` literal whose atom has positive evidence.
 */
import {isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';

const strip = v => v.replace(/^\?/, '');
const rowKey = row => JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Atoms and constraints of the query for the type inference, and the clause generator. */
export function pushdownPlan(qp) {
  for (const alt of qp.alts) {
    const bound = new Set(alt.bound);
    if (qp.projection.some(v => !bound.has(v))) throw new NotExpressibleError(['query_projection'], 'an alternative of the query does not bind every projected variable');
  }
  const extraAtoms = [], extraConstraints = [];
  for (const alt of qp.alts) for (const l of alt.leaves) {
    if (l.kind === 'atom') extraAtoms.push({p: l.p, args: l.args, scope: 'q'});
    else extraConstraints.push({kind: 'compare', scope: 'q', word: l.word, left: l.left, right: l.right});
  }
  const proj = qp.projection;
  const extra = ctx => {
    const colType = v => ctx.types.typeOfVar('q', v);
    const sig = proj.map((v, i) => `c${i}:${colType(v)}`).join(', ');
    const cols = proj.map(colType);
    ctx.decls.set('x_q_rows', {raw: `.decl x_q_rows(${sig})`});
    ctx.decls.set('x_q_clean', {raw: `.decl x_q_clean(${sig})`});
    const head = name => `${name}(${proj.map(v => 'V_' + strip(v)).join(', ')})`;
    const refs = [];
    qp.alts.forEach((alt, a) => {
      const body = ctx.bodyOf(alt.leaves, 'q', null);
      ctx.clauses.push(`${head('x_q_rows')} :- ${body.join(', ')}.`);
      const opposite = alt.leaves.filter(l => l.kind === 'atom' && l.mode !== 'absent').map(l => `!${ctx.atomText(l.mode === 'pos', l.p, l.args, 'q')}`);
      ctx.clauses.push(`${head('x_q_clean')} :- ${[...body, ...opposite].join(', ')}.`);
      alt.leaves.forEach((l, k) => {
        if (l.kind !== 'atom') return;
        const ground = l.args.every(t => !isVarTerm(t));
        const flag = `x_q_ref_${a}_${k}`;
        if (l.mode === 'pos') {
          const closed = qp.closed.has(l.p);
          if (!ground && !closed) return;
          ctx.decls.set(flag, {raw: `.decl ${flag}()`});
          if (ground) ctx.clauses.push(`${flag}() :- ${ctx.atomText(true, l.p, l.args, 'q')}.`);
          if (closed) {
            ctx.decls.set(flag + '_pat', {raw: `.decl ${flag}_pat()`});
            ctx.clauses.push(`${flag}_pat() :- ${ctx.atomText(false, l.p, l.args, 'q')}.`, `${flag}() :- !${flag}_pat().`);
          }
        } else if (ground) {
          ctx.decls.set(flag, {raw: `.decl ${flag}()`});
          ctx.clauses.push(`${flag}() :- ${ctx.atomText(false, l.p, l.args, 'q')}.`);
        } else return;
        refs.push({rel: flag, key: `ref|${a}|${k}`, cols: []});
      });
    });
    ctx.outputs.push({rel: 'x_q_rows', key: 'q|rows', cols}, {rel: 'x_q_clean', key: 'q|clean', cols}, ...refs);
  };
  return {extraAtoms, extraConstraints, extra};
}

/** The outcome (the shape of the oracle's `evaluatePart`) of a select, exists or count query from the rows Soufflé returned. */
export function outcomeFromRows(qp, tables) {
  const clean = new Set((tables.get('q|clean') ?? []).map(r => JSON.stringify(r)));
  const seen = new Map();
  for (const r of tables.get('q|rows') ?? []) {
    const row = Object.fromEntries(qp.projection.map((v, i) => [strip(v), r[i]]));
    seen.set(rowKey(row), {row, both: !clean.has(JSON.stringify(r)), prem: []});
  }
  const list = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
  const refFlag = (a, k) => (tables.get(`ref|${a}|${k}`) ?? []).length > 0;
  const refuted = !list.length && qp.alts.every((alt, a) => alt.leaves.some((l, k) => l.kind === 'atom' && refFlag(a, k)));
  if (qp.mode === 'count') {
    const exact = qp.domainClosed;
    return {status: list.length || exact ? 'supported' : 'unknown', rows: list, count: list.length, ...(exact ? {} : {bound: 'at_least'}), roots: [], supportIncomplete: true};
  }
  if (list.length) return {status: list.some(r => !r.both) ? 'supported' : 'both', rows: list, roots: [], supportIncomplete: false};
  return {status: refuted ? 'refuted' : 'unknown', rows: [], roots: [], supportIncomplete: refuted};
}
