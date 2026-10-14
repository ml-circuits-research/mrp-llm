/**
 * Lowering of the norms over a trace (proposal 8.2 qualifiers, 8.4 rule 3) into core rules over the step-indexed state
 * (lower-state.mjs). The definitions are those of ../modes/run-eval.mjs, which the planner runs as monitors; the shadow test compares
 * the two on the smoke cases and on generated traces. Every norm gets relations named after it (nm = its id as a symbol):
 *
 *   forbid ~a      x_c_match_nm i V  an occurrence of the pattern at step i whose `when` holds in state i-1; x_c_blkby_nm_o i T (norm o overrides);
 *                  x_c_occ_nm i V    the occurrence that no override blocks; x_c_viol_nm i V  the violations (the host keeps the first step per V);
 *   forbid ATOM    x_c_viol_nm k V   the atom holds with `when` in state k;
 *   oblige         x_c_trig0_nm k V  `when` holds in state k for relevant values (x_c_rel: goal constants or parameters of steps <= k+1; `standing`
 *                  waives it), x_c_trig_nm the first such k; then x_c_occ_nm / x_c_hold_nm, x_c_met_nm and x_c_viol_nm by qualifier.
 * V are the variables of the norm's pattern. A violation of an unmet obligation is reported at its deadline or at the last step.
 */
import {NotExpressibleError} from '../js-reference/values.mjs';
import {S, DID, leafText} from './lower-state.mjs';
import {sym, T, Q} from './emit.mjs';

const K = '?c_k', I = '?c_i', J = '?c_j', M = '?c_m', D = '?c_d', E = '?c_e', N_ = '?c_n', H = '?c_h';

export function lowerNorms({out, norms, edges, steps, world, tl, meta}) {
  const R = (name, ...cols) => { out.declare(name, cols.length); return [name, ...cols.map(T)].join(' '); };
  const actionArity = a => { const act = world.actions.get(a); if (!act) throw new NotExpressibleError(['check_plan'], `a norm or method names the action ${a}, which is not in force`); return act.params.length; };
  const didAtom = (a, step, terms) => { out.declare(DID(a), 1 + actionArity(a)); return `${DID(a)} ${[step, ...terms.map(T)].join(' ')}`; };
  const fresh = (prefix, n) => Array.from({length: n}, (_, i) => `?c_${prefix}${i + 1}`);
  const byId = new Map(norms.map(n => [n.id, n]));
  const n = steps.length;

  // relations over the trace used by several norms
  const seen = new Map(), done = new Map();
  const seenRel = (b, strict) => {
    const map = strict ? seen : done, name = `x_c_${strict ? 'seen' : 'done'}_${sym(b)}`;
    if (map.has(b)) return name;
    map.set(b, name);
    out.declare(name, 1);
    out.rule(`${name} ${I}`, [didAtom(b, J, fresh('b', actionArity(b))), `x_c_state ${I}`, `compare ${J} ${strict ? 'below' : 'at_most'} ${I}`]);
    return name;
  };
  let relOut = null;
  const relRel = () => {
    if (relOut) return relOut;
    relOut = out.declare('x_c_rel', 2);
    for (const a of new Set(steps.map(s => s.action))) {
      const k = actionArity(a), ps = fresh('p', k);
      for (let t = 0; t < k; t++) out.rule(`x_c_rel ${ps[t]} ${K}`, [didAtom(a, J, ps), `x_c_state ${K}`, `compute ?c_k1 ${K} plus 1`, `compare ${J} at_most ?c_k1`]);
    }
    return relOut;
  };
  let dayk = false;
  const dayRel = () => {
    if (dayk) return;
    dayk = true;
    out.declare('x_c_dayk', 2);
    for (let k = 0; k <= n; k++) out.fact(`x_c_dayk ${k} ${tl.days[Math.max(k, 1)]}`);
  };

  for (const N of norms) {
    if (N.modality === 'permit') continue;
    const nm = sym(N.id), V = N.patVars, whenAt = (alt, at) => alt.map(l => leafText(l, at));
    const q = N.qual, inforce = at => `x_c_inforce ${Q(N.id)} ${at}`;
    const viol = (step, ...extra) => R(`x_c_viol_${nm}`, step, ...V);
    meta.viol.push({norm: N, rel: `x_c_viol_${nm}`, arity: 1 + V.length});

    if (N.modality === 'forbid' && N.pat.kind === 'action') {
      const a = N.pat.action;
      for (const alt of N.whenAlts) out.rule(R(`x_c_match_${nm}`, I, ...V), [inforce(I), didAtom(a, I, N.pat.terms), `x_c_succ ${H} ${I}`, ...whenAt(alt, H)]);
      meta.match.push({norm: N, rel: `x_c_match_${nm}`});
      const blockers = edges.filter(e => e.target === N.id).map(e => byId.get(e.over)).filter(Boolean);
      for (const O of blockers) {
        if (O.pat.kind !== 'action' || O.pat.action !== a) throw new NotExpressibleError(['overrides'], `the norm ${O.id} overrides ${N.id} but does not concern the same action`);
        const so = sym(O.id);
        for (const alt of O.whenAlts) out.rule(R(`x_c_blkby_${nm}_${so}`, I, ...O.pat.terms), [`x_c_inforce ${Q(O.id)} ${I}`, didAtom(a, I, O.pat.terms), `x_c_succ ${H} ${I}`, ...whenAt(alt, H)]);
        const tv = N.pat.terms.map((_, i) => `?c_t${i + 1}`);
        out.rule(R(`x_c_blk_${nm}`, I, ...tv), [R(`x_c_blkby_${nm}_${so}`, I, ...tv)]);
        out.rule(R(`x_c_ovr_${nm}_${so}`, I, ...V), [R(`x_c_match_${nm}`, I, ...V), R(`x_c_blkby_${nm}_${so}`, I, ...N.pat.terms)]);
        meta.override.push({over: O, target: N, rel: `x_c_ovr_${nm}_${so}`});
      }
      const occ = (step, vars) => R(`x_c_occ_${nm}`, step, ...vars);
      if (blockers.length) out.rule(occ(I, V), [R(`x_c_match_${nm}`, I, ...V), 'absent ' + R(`x_c_blk_${nm}`, I, ...N.pat.terms)]);
      else out.rule(occ(I, V), [R(`x_c_match_${nm}`, I, ...V)]);
      const head = viol(I);
      if (q.kind === 'always') out.rule(head, [occ(I, V)]);
      else if (q.kind === 'before') out.rule(head, [occ(I, V), `absent ${seenRel(q.ref, true)} ${I}`]);
      else if (q.kind === 'after') out.rule(head, [occ(I, V), `${seenRel(q.ref, true)} ${I}`]);
      else out.rule(head, [occ(I, V), occ(J, V), `compare ${J} below ${I}`]);
      continue;
    }
    if (N.modality === 'forbid') {
      if (q.kind === 'at_most_once') throw new NotExpressibleError(['temporal_norms'], `at_most_once over the state atom of ${N.id}`);
      for (const alt of N.whenAlts) {
        const body = [inforce(K), `${S(N.pat.p)} ${[K, ...N.pat.terms.map(T)].join(' ')}`, ...whenAt(alt, K)];
        if (q.kind === 'before') body.push(`absent ${seenRel(q.ref, false)} ${K}`);
        if (q.kind === 'after') body.push(`${seenRel(q.ref, false)} ${K}`);
        out.rule(viol(K), body);
      }
      meta.match.push({norm: N, rel: `x_c_viol_${nm}`});
      continue;
    }

    // oblige
    const trig0 = (k, ...extra) => R(`x_c_trig0_${nm}`, k, ...V);
    for (const alt of N.whenAlts) {
      const body = [inforce(K), ...whenAt(alt, K)];
      if (!N.standing) for (const v of V) body.push(`${relRel()} ${v} ${K}`);
      out.rule(trig0(K), body);
    }
    out.rule(R(`x_c_early_${nm}`, K, ...V), [trig0(K), R(`x_c_trig0_${nm}`, J, ...V), `compare ${J} below ${K}`]);
    const TR = R(`x_c_trig_${nm}`, K, ...V);
    out.rule(TR, [trig0(K), 'absent ' + R(`x_c_early_${nm}`, K, ...V)]);
    meta.trig.push({norm: N, rel: `x_c_trig_${nm}`, arity: 1 + V.length});
    const met = (k, ...cols) => R(`x_c_met_${nm}`, k, ...V);
    const deadline = qn => [TR, `compute ${D} ${K} plus ${qn}`, `x_c_last ${N_}`];
    const unmet = (head, body) => out.rule(head, body);
    const endViol = body => out.rule(viol(N_), [TR, `x_c_last ${N_}`, ...body]);
    const withinViol = qn => {
      unmet(viol(D), [...deadline(qn), `compare ${D} at_most ${N_}`, 'absent ' + met(K)]);
      unmet(viol(N_), [...deadline(qn), `compare ${D} above ${N_}`, 'absent ' + met(K)]);
    };
    if (N.pat.kind === 'action') {
      const a = N.pat.action, occ = step => (out.declare(`x_c_occ_${nm}`, 1 + V.length), `x_c_occ_${nm} ${[step, ...V].join(' ')}`);
      out.rule(occ(I), [didAtom(a, I, N.pat.terms)]);
      if (q.kind === 'sometime') { out.rule(met(K), [TR, occ(I), `compare ${I} above ${K}`]); endViol(['absent ' + met(K)]); }
      else if (q.kind === 'within' && !tl.days) {
        out.rule(met(K), [TR, occ(I), `compare ${I} above ${K}`, `compute ${D} ${K} plus ${q.n}`, `compare ${I} at_most ${D}`]);
        withinViol(q.n);
      } else if (q.kind === 'within') {
        dayRel();
        out.rule(met(K), [TR, occ(I), `compare ${I} above ${K}`, `x_c_dayk ${K} ?c_dk`, `x_c_dayk ${I} ?c_di`, `compute ${E} ?c_di minus ?c_dk`, `compare ${E} at_most ${q.n}`]);
        const late = R(`x_c_late_${nm}`, J, K, ...V);
        out.rule(late, [TR, `x_c_dayk ${K} ?c_dk`, `x_c_dayk ${J} ?c_dj`, `compare ${J} above ${K}`, `compute ${E} ?c_dj minus ?c_dk`, `compare ${E} above ${q.n}`]);
        out.rule(R(`x_c_laterl_${nm}`, J, K, ...V), [late, R(`x_c_late_${nm}`, M, K, ...V), `compare ${M} below ${J}`]);
        out.rule(viol(J), [late, 'absent ' + R(`x_c_laterl_${nm}`, J, K, ...V), 'absent ' + met(K)]);
        out.rule(R(`x_c_hasl_${nm}`, K, ...V), [R(`x_c_late_${nm}`, J, K, ...V)]);
        endViol(['absent ' + R(`x_c_hasl_${nm}`, K, ...V), 'absent ' + met(K)]);
      } else if (q.kind === 'before' || q.kind === 'after') {
        const b = q.ref, bany = (j, ...cols) => R(`x_c_bany_${nm}`, j, ...V);
        out.rule(bany(J), [TR, didAtom(b, J, fresh('b', actionArity(b))), `compare ${J} above ${K}`]);
        if (q.kind === 'before') {
          out.rule(R(`x_c_bearlier_${nm}`, J, ...V), [bany(J), R(`x_c_bany_${nm}`, M, ...V), `compare ${M} below ${J}`]);
          out.rule(R(`x_c_bfirst_${nm}`, J, ...V), [bany(J), 'absent ' + R(`x_c_bearlier_${nm}`, J, ...V)]);
          out.rule(R(`x_c_ok_${nm}`, J, ...V), [R(`x_c_bfirst_${nm}`, J, ...V), TR, occ(I), `compare ${I} above ${K}`, `compare ${I} below ${J}`]);
          out.rule(viol(J), [R(`x_c_bfirst_${nm}`, J, ...V), 'absent ' + R(`x_c_ok_${nm}`, J, ...V)]);
        } else {
          out.rule(R(`x_c_blater_${nm}`, J, ...V), [bany(J), R(`x_c_bany_${nm}`, M, ...V), `compare ${M} above ${J}`]);
          out.rule(R(`x_c_blast_${nm}`, J, ...V), [bany(J), 'absent ' + R(`x_c_blater_${nm}`, J, ...V)]);
          out.rule(R(`x_c_okb_${nm}`, J, ...V), [R(`x_c_blast_${nm}`, J, ...V), occ(I), `compare ${I} above ${J}`]);
          out.rule(viol(N_), [R(`x_c_blast_${nm}`, J, ...V), `x_c_last ${N_}`, 'absent ' + R(`x_c_okb_${nm}`, J, ...V)]);
        }
      } else throw new NotExpressibleError(['temporal_norms'], `${q.kind} over the action of ${N.id}`);
    } else {
      const hold = at => { out.declare(`x_c_hold_${nm}`, 1 + V.length); return `x_c_hold_${nm} ${[at, ...V].join(' ')}`; };
      out.rule(hold(M), [`${S(N.pat.p)} ${[M, ...N.pat.terms.map(T)].join(' ')}`]);
      if (q.kind === 'sometime') { out.rule(met(K), [TR, hold(M), `compare ${M} at_least ${K}`]); endViol(['absent ' + met(K)]); }
      else if (q.kind === 'within') {
        out.rule(met(K), [TR, hold(M), `compare ${M} at_least ${K}`, `compute ${D} ${K} plus ${q.n}`, `compare ${M} at_most ${D}`]);
        withinViol(q.n);
      } else if (q.kind === 'always') {
        out.rule(R(`x_c_nh_${nm}`, M, ...V), [TR, `x_c_state ${M}`, `compare ${M} at_least ${K}`, 'absent ' + hold(M)]);
        out.rule(R(`x_c_nhe_${nm}`, M, ...V), [R(`x_c_nh_${nm}`, M, ...V), R(`x_c_nh_${nm}`, J, ...V), `compare ${J} below ${M}`]);
        out.rule(viol(M), [R(`x_c_nh_${nm}`, M, ...V), 'absent ' + R(`x_c_nhe_${nm}`, M, ...V)]);
      } else throw new NotExpressibleError(['temporal_norms'], `${q.kind} over the state atom of ${N.id}`);
    }
  }
}
