/**
 * Adapter of the WRAPPER `reasoning/strategies/dreaming-session/` around the oracle (`js-oracle`): not a strategy, no coverage of its
 * own (it inherits the wrapped strategy's, minus the probe-unit budget cases, because a learned plan changes how many probes a task costs).
 *
 * Per case: ask the circuits three times (the journal), dream, then answer with the FROZEN PLAN and the shadow option on, and return that
 * answer: the harness therefore checks DREAM EQUIVALENCE (the deployed answer equals the expected one). A case that carries a schema
 * change marks the new wires `new_*`: the session first dreams on the old schema (the `new_*` wires removed, the wires they supersede back
 * in force), then is asked the new one, which must retire the plan on re-certification and still answer correctly.
 */
import {jsReference, NotExpressibleError} from '../../../reasoning/strategies/js-reference/index.mjs';
import {dreamingSession} from '../../../reasoning/strategies/dreaming-session/index.mjs';
import {parse, wiresText, tokens} from '../../../sop/knowledge/index.mjs';
import {NotExpressible} from './common.mjs';

/** The old schema of a case: drop `new_*` wires, and put back in force the wires they supersede. */
export function oldSchema(knowledge) {
  const {wires} = parse(knowledge);
  const removed = wires.filter(w => w.id.startsWith('new_'));
  if (!removed.length) return null;
  const targets = new Set(removed.flatMap(w => w.fields.filter(f => f.key === 'supersedes').map(f => f.value.trim().slice(1))));
  const kept = wires.filter(w => !w.id.startsWith('new_')).map(w => (targets.has(w.id) ? {...w, fields: w.fields.map(f => (f.key === 'approval' ? {...f, value: 'approved'} : f))} : w));
  return wiresText(kept);
}

export const dreamingSessionAdapter = {
  id: 'dreaming-session', status: 'available', wrapper: true, origin: 'reasoning/strategies/dreaming-session/ wrapping js-oracle',
  description: 'Wrapper, not a strategy: journal, certified join-order skills, a frozen deployment plan, quarantine and revoke, negative cache; runs the wrapped oracle.',
  supports: new Set(jsReference.features.filter(f => f !== 'budget_probes')),
  async available() { return {ok: true}; },
  run(c, ctx) {
    try {
      const session = dreamingSession(jsReference, {shadowEvery: 1});
      const old = oldSchema(c.knowledge);
      const ask = (knowledge, options = {}) => session.ask({theory: {knowledge}, query: c.query}, {}, options);
      if (old) { for (let i = 0; i < 3; i++) ask(old); ctx.dreamOld = session.dream({minTasks: 3, minScore: 0}); }
      else { for (let i = 0; i < 3; i++) ask(c.knowledge); ctx.dream = session.dream({minTasks: 3, minScore: 0}); }
      const packet = ask(c.knowledge, {shadow: true});
      ctx.packet = packet; ctx.session = session;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
