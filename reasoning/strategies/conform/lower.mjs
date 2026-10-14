/**
 * Conformance lowered to core rules (proposal 8.4 rule 3 and round-2 SHOULD 5): a `trace` plus the norms and methods in force at
 * the time of its steps become ONE core program (facts and rules, no new feature) that derives `violated` (x_c_viol_*), `deviation`
 * (x_c_dev_*) and `compliant` (x_c_compliant). A trace is a closed, finite record, so negation as failure over its relations is
 * sound and the program runs on the oracle and on any core strategy that has negation as failure and comparisons.
 *
 *   lowerTrace({ctx, steps}) -> {text, meta, program, world, tl}   `text` is the knowledge circuit, `meta` names the relations to read.
 *
 * The state of the trace is lowered by lower-state.mjs, the norms by lower-norms.mjs, the methods by lower-methods.mjs; this module
 * orders them, adds the compliance rules and declares the shape of what the host reads back.
 */
import {compileForce} from '../modes/theory.mjs';
import {timeline} from '../modes/timeline.mjs';
import {World} from '../modes/world.mjs';
import {Out} from './emit.mjs';
import {neededPredicates, lowerState} from './lower-state.mjs';
import {lowerNorms} from './lower-norms.mjs';
import {lowerMethods} from './lower-methods.mjs';

export function lowerTrace({ctx, steps}) {
  const tl = timeline(ctx, steps);
  const program = compileForce(tl.unionWires, ctx.queryWires);
  const world = new World(program, ctx.budget);
  const out = new Out();
  const meta = {viol: [], match: [], override: [], trig: [], dev: []};
  const {need, use} = neededPredicates({norms: tl.norms, methods: tl.methods, program});
  lowerState({out, program, world, steps, tl, need, use});
  lowerNorms({out, norms: tl.norms, edges: tl.edges, steps, world, tl, meta});
  lowerMethods({out, methods: tl.methods, steps, world, tl, meta});
  // compliance: a hard strict violation or a deviation from a strict method makes the trace non-compliant
  out.declare('x_c_noncompliant', 0); out.declare('x_c_compliant', 0);
  for (const v of meta.viol) {
    if (v.norm.severity !== 'hard' || v.norm.binding !== 'strict') continue;
    const cols = Array.from({length: v.arity}, (_, i) => `?c_x${i}`).join(' ');
    out.rule('x_c_noncompliant', [`${v.rel} ${cols}`]);
  }
  for (const d of meta.dev) {
    if (d.method.binding !== 'strict') continue;
    out.rule('x_c_noncompliant', [`${d.rel} ${Array.from({length: d.arity}, (_, i) => `?c_x${i}`).join(' ')}`.trim()]);
  }
  out.rule('x_c_compliant', ['absent x_c_noncompliant']);
  return {text: out.text(), meta, program, world, tl};
}
