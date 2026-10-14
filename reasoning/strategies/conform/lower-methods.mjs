/**
 * Lowering of method deviation (proposal 8.4, rule 2) into core rules: a chart of the method's steps over the trace, the same
 * definitions as ../modes/deviation.mjs (see there for ENGAGED, SCOPE and the state tested at a position).
 *
 *   x_c_eng_m A        an instance (a binding A of the achieves variables) taken from a step that performs a primitive of the method;
 *   x_c_scope_m j A    step j, performed while m is in force, mentions a value of A (all steps for a method without variables);
 *   x_c_pos_m a s A    a position (the trace index a of the last consumed scope step, 0 = none yet) and the state s tested there;
 *   x_c_nx_m a b A     the next scope step after position a;
 *   x_c_apply_m A      the instance is engaged and the method's `when` holds before its first scope step;
 *   x_c_cK_m a b V     the chart: steps K of the method consume the scope steps (a, b] under the variable binding V;
 *   x_c_ok_m A         the scope is exactly one legal run;     x_c_dev_m A   an applied instance whose scope is not.
 * Every chart relation holds all the variables of the method (at most four), a variable a node does not bind ranges over x_c_dom.
 */
import {NotExpressibleError} from '../js-reference/values.mjs';
import {primitivesOf, varsOfTerms} from '../modes/model.mjs';
import {conformanceBlocker} from '../modes/deviation.mjs';
import {DID, leafText} from './lower-state.mjs';
import {sym, T, Q} from './emit.mjs';

const H = '?c_h', J = '?c_j', F = '?c_f', A_ = '?c_a', B_ = '?c_b', C_ = '?c_c', M_ = '?c_m', MID = '?c_mid';

function* permutations(items) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
}

function allVars(nodes, acc = new Set()) {
  for (const n of nodes) {
    for (const v of n.terms ? varsOfTerms(n.terms) : []) acc.add(v);
    if (n.item) allVars([n.item], acc);
    for (const k of ['branches', 'items', 'then', 'otherwise', 'body']) if (n[k]) allVars(n[k], acc);
  }
  return acc;
}

export function lowerMethods({out, methods, steps, world, tl, meta}) {
  const R = (name, ...cols) => { out.declare(name, cols.length); return [name, ...cols.map(T)].join(' '); };
  const actionArity = a => { const act = world.actions.get(a); if (!act) throw new NotExpressibleError(['check_plan'], `a method names the action ${a}, which is not in force`); return act.params.length; };
  const didAtom = (a, step, terms) => { out.declare(DID(a), 1 + actionArity(a)); return `${DID(a)} ${[step, ...terms.map(T)].join(' ')}`; };
  const fresh = (prefix, n) => Array.from({length: n}, (_, i) => `?c_${prefix}${i + 1}`);
  const traceActions = new Set(steps.map(s => s.action));

  for (const M of methods) {
    const names = new Set(primitivesOf(M.steps).map(p => p.action));
    if (![...names].some(a => steps.some((s, k) => s.action === a && tl.inForceAt(M, k + 1)))) continue;
    const bad = conformanceBlocker(M, steps, tl.inForceAt);
    if (bad) throw new NotExpressibleError(['conform_deviation'], `method ${M.id}: ${bad} steps are not checked in conformance`);
    const m = sym(M.id);
    const A = varsOfTerms(M.achieves.terms), Vall = [...new Set([...A, ...allVars(M.steps)])];
    if (Vall.length > 4) throw new NotExpressibleError(['conform_deviation'], `method ${M.id} has more than four variables`);
    const dom = bound => Vall.filter(v => !bound.has(v)).map(v => `x_c_dom ${v}`);
    const baseBound = new Set(A);
    const inforce = at => `x_c_inforce ${Q(M.id)} ${at}`;
    const eng = (...a) => R(`x_c_eng_${m}`, ...a), scope = (j, ...a) => R(`x_c_scope_${m}`, j, ...a);
    const pos = (a, s) => R(`x_c_pos_${m}`, a, s, ...A);

    // engagement, scope, positions
    for (const P of primitivesOf(M.steps)) {
      const pv = new Set(varsOfTerms(P.terms));
      out.rule(eng(...A), [inforce(J), didAtom(P.action, J, P.terms), ...A.filter(v => !pv.has(v)).map(v => `x_c_dom ${v}`)]);
    }
    if (!A.length) out.rule(scope(J), [eng(), inforce(J), `x_c_succ ${H} ${J}`]);
    else for (const a of traceActions) {
      const k = actionArity(a);
      for (let t = 0; t < k; t++) for (let u = 0; u < A.length; u++) {
        const ps = fresh('p', k); ps[t] = A[u];
        out.rule(scope(J, ...A), [eng(...A), inforce(J), didAtom(a, J, ps)]);
      }
    }
    out.rule(R(`x_c_pre_${m}`, F, ...A), [scope(M_, ...A), `compare ${M_} below ${F}`, scope(F, ...A)]);
    out.rule(R(`x_c_first_${m}`, F, ...A), [scope(F, ...A), 'absent ' + R(`x_c_pre_${m}`, F, ...A)]);
    out.rule(R(`x_c_aft_${m}`, J, ...A), [scope(M_, ...A), `compare ${M_} above ${J}`, scope(J, ...A)]);
    out.rule(R(`x_c_lastsc_${m}`, J, ...A), [scope(J, ...A), 'absent ' + R(`x_c_aft_${m}`, J, ...A)]);
    out.rule(R(`x_c_pos_${m}`, 0, '?c_s', ...A), [R(`x_c_first_${m}`, F, ...A), `x_c_succ ?c_s ${F}`]);
    out.rule(R(`x_c_pos_${m}`, A_, A_, ...A), [scope(A_, ...A)]);
    out.rule(R(`x_c_btw_${m}`, A_, B_, ...A), [pos(A_, '?c_s'), scope(M_, ...A), `compare ${M_} above ${A_}`, `compare ${M_} below ${B_}`, scope(B_, ...A)]);
    out.rule(R(`x_c_nx_${m}`, A_, B_, ...A), [pos(A_, '?c_s'), scope(B_, ...A), `compare ${B_} above ${A_}`, 'absent ' + R(`x_c_btw_${m}`, A_, B_, ...A)]);
    const nx = (a, b) => R(`x_c_nx_${m}`, a, b, ...A);
    const apply = R(`x_c_apply_${m}`, ...A);
    for (const alt of M.whenAlts) out.rule(apply, [R(`x_c_first_${m}`, F, ...A), `x_c_succ ${H} ${F}`, ...alt.map(l => leafText(l, H))]);

    // the chart
    let counter = 0;
    const rel = () => `x_c_c${++counter}_${m}`;
    const row = (name, a, b) => R(name, a, b, ...Vall);
    const emptyRel = () => { const n = rel(); out.rule(row(n, A_, A_), [pos(A_, '?c_s'), ...dom(baseBound)]); return n; };
    const condRel = node => {
      const n = rel(), mode = node.neg === 'none' ? 'pos' : node.neg === 'not' && world.closed.has(node.p) ? 'absent' : node.neg;
      out.rule(R(n, '?c_s', ...A), [apply, 'x_c_state ?c_s', leafText({kind: 'atom', mode, p: node.p, args: node.terms}, '?c_s')]);
      return n;
    };
    const seq = nodes => {
      if (!nodes.length) return emptyRel();
      const [h, ...rest] = nodes;
      if (h.kind === 'pick') {
        const n = rel(), tail = seq(rest), mode = h.neg === 'none' ? 'pos' : h.neg;
        out.rule(row(n, A_, B_), [pos(A_, '?c_s'), leafText({kind: 'atom', mode, p: h.p, args: h.terms}, '?c_s'), row(tail, A_, B_)]);
        return n;
      }
      const f = node(h);
      if (!rest.length) return f;
      const r = seq(rest), n = rel();
      out.rule(row(n, A_, C_), [row(f, A_, MID), row(r, MID, C_)]);
      return n;
    };
    const node = x => {
      const n = rel();
      switch (x.kind) {
        case 'prim': {
          const bound = new Set([...baseBound, ...varsOfTerms(x.terms)]);
          out.rule(row(n, A_, B_), [nx(A_, B_), didAtom(x.action, B_, x.terms), ...dom(bound)]);
          return n;
        }
        case 'optional': out.rule(row(n, A_, B_), [row(node(x.item), A_, B_)]); out.rule(row(n, A_, A_), [pos(A_, '?c_s'), ...dom(baseBound)]); return n;
        case 'choose': for (const b of x.branches) out.rule(row(n, A_, B_), [row(node(b), A_, B_)]); return n;
        case 'any_order': {
          if (x.items.length > 4) throw new NotExpressibleError(['conform_deviation'], `any_order with more than four steps in ${M.id}`);
          for (const perm of permutations(x.items)) out.rule(row(n, A_, B_), [row(seq(perm), A_, B_)]);
          return n;
        }
        case 'if': {
          const c = condRel(x), cond = R(c, '?c_s', ...A);
          out.rule(row(n, A_, B_), [pos(A_, '?c_s'), cond, row(seq(x.then), A_, B_)]);
          out.rule(row(n, A_, B_), [pos(A_, '?c_s'), 'absent ' + cond, row(seq(x.otherwise), A_, B_)]);
          return n;
        }
        case 'until': {
          const c = condRel(x), cond = R(c, '?c_s', ...A), body = seq(x.body);
          const levels = Array.from({length: x.max + 1}, () => rel());
          levels.forEach((lv, i) => {
            out.rule(row(lv, A_, A_), [pos(A_, '?c_s'), cond, ...dom(baseBound)]);
            if (i > 0) out.rule(row(lv, A_, B_), [pos(A_, '?c_s'), 'absent ' + cond, row(body, A_, MID), row(levels[i - 1], MID, B_)]);
          });
          return levels[x.max];
        }
        default: throw new NotExpressibleError(['conform_deviation'], `the step form ${x.kind} of ${M.id} is not lowered`);
      }
    };
    const top = seq(M.steps);
    out.rule(R(`x_c_ok_${m}`, ...A), [pos(0, '?c_s'), row(top, 0, B_), R(`x_c_lastsc_${m}`, B_, ...A)]);
    out.rule(R(`x_c_dev_${m}`, ...A), [apply, 'absent ' + R(`x_c_ok_${m}`, ...A)]);
    meta.dev.push({method: M, rel: `x_c_dev_${m}`, apply: `x_c_apply_${m}`, arity: A.length});
  }
}

