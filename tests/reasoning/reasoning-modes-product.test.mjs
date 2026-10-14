// The reasoning modes of a model query on the product path (DS006 "Routing rules" R1, DS014): `why_not` and `abduce` are answered by the
// js-reference oracle, `explain` names the rules it used, an abduction is consistent with the admitted facts (logic book items 541 and 501
// as small SOP programs), and a negated claim over a closed session predicate whose positive form is proved is `refuted`, not withheld.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ask} from '../../reasoning/strategies/js-reference/index.mjs';
import {Agent} from '../../server/agent.mjs';
import {AuthorRuntime} from '../../lib/query-author/runtime.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {context} from '../helpers.mjs';

const oracle = (knowledge, query) => ask({theory: {knowledge}, query});

// logic:541, a closed incident note: the gate is open, the padlock is closed, there are no tool marks. Forced entry would leave tool marks.
const INCIDENT = `@r_forced_open rule\n  when forced_entry ?s\n  then gate_open ?s\n@r_forced_marks rule\n  when forced_entry ?s\n  then tool_marks ?s\n`
  + `@r_key_open rule\n  when key_entry ?s\n  then gate_open ?s\n@h_forced hypothesis\n  holds forced_entry yard\n@h_key hypothesis\n  holds key_entry yard\n`;

test('abduce rejects an explanation whose consequences contradict an admitted fact (logic:541)', () => {
  const r = oracle(INCIDENT + '@f1 fact\n  holds padlock_closed yard\n@f2 fact\n  holds not tool_marks yard\n', '@q query\n  mode abduce\n  where gate_open yard\n');
  assert.equal(r.status, 'hypotheses');
  assert.deepEqual(r.explanations.map(e => e.hypotheses), [['h_key']]);
  assert.deepEqual(r.inconsistent.map(e => [e.hypotheses, e.contradicts]), [[['h_forced'], ['not tool_marks yard']]]);
  // without the note's "no tool marks" both stories explain the open gate
  const open = oracle(INCIDENT, '@q query\n  mode abduce\n  where gate_open yard\n');
  assert.deepEqual(open.explanations.map(e => e.hypotheses[0]).sort(), ['h_forced', 'h_key']);
  assert.equal(open.inconsistent, undefined);
});

test('abduce keeps the stories that fit the listed signs and rejects the one that fights the lit neighbour lamp (logic:501)', () => {
  const k = '@f1 fact\n  holds lamp east\n@f2 fact\n  holds lamp west\n@f3 fact\n  holds lit west\n'
    + '@r_bulb rule\n  when dead_bulb ?l\n  then dark ?l\n@r_grid rule\n  when grid_failed\n  when lamp ?l\n  then dark ?l\n@r_dark rule\n  when dark ?l\n  then not lit ?l\n'
    + '@r_moth rule\n  when moth_jam ?l\n  then dark ?l\n'
    + '@h_bulb hypothesis\n  holds dead_bulb east\n  cost 1\n@h_grid hypothesis\n  holds grid_failed\n  cost 1\n@h_moth hypothesis\n  holds moth_jam east\n  cost 3\n';
  const r = oracle(k, '@q query\n  mode abduce\n  where dark east\n');
  assert.equal(r.status, 'hypotheses');
  assert.deepEqual(r.explanations.map(e => e.hypotheses), [['h_bulb'], ['h_moth']], 'the cheapest consistent story first');
  assert.deepEqual(r.inconsistent.map(e => [e.hypotheses, e.contradicts]), [[['h_grid'], ['lit west']]]);
  // every explaining story contradicts a fact: no consistent explanation, and the rejected ones are reported
  const none = oracle(k.replace(/@h_bulb[\s\S]*$/, '@h_grid hypothesis\n  holds grid_failed\n'), '@q query\n  mode abduce\n  where dark east\n');
  assert.equal(none.status, 'unknown');
  assert.equal(none.reason, 'no_consistent_explanation');
  assert.equal(none.inconsistent.length, 1);
});

test('abduce: an observation that already holds is still explained by the empty set (the shared semantics of the engines)', () => {
  const r = oracle(INCIDENT + '@f1 fact\n  holds gate_open yard\n', '@q query\n  mode abduce\n  where gate_open yard\n');
  assert.deepEqual(r.hypotheses, [[]]);
});

// The product path: a fixed formalizer output through Agent.turn (the chat), or through the AuthorRuntime with a memory that holds hypotheses.
const session = '@apprentice predicate\n  args subject:entity\n@at_grinder predicate\n  args subject:entity\n@wears_shield predicate\n  args subject:entity\n';
const stated = (id, relation, subject, polarity = 'affirmed') => `@${id} stated\n  certainty asserted\n  relation "${relation}"\n  role subject "${subject}"\n  polarity ${polarity}\n`;
const rule = '@r_shield rule\n  when apprentice ?x\n  when at_grinder ?x\n  then wears_shield ?x\n';
const question = (polarity, mode = null) => `@q query\n${mode ? `  mode ${mode}\n` : ''}  where match\n    relation "wears_shield"\n    role subject "Sam"\n    polarity ${polarity}\n  end\n`;

async function turn(t, message, sop) {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  const agent = new Agent({repo: c.repo, session: c.session, lexicon: new Lexicon('@works_at predicate\n  args subject:entity object:entity\n'), config: {}});
  return agent.turn(message, {language: 'en', formalizer: {formalize: async () => sop}});
}

test('why_not of a model query is routed to the oracle: the missing fact is named, not reported not_computable', async t => {
  const r = await turn(t, 'Sam is an apprentice. Why does Sam not wear the shield?', session + stated('s1', 'apprentice', 'Sam') + rule + question('affirmed', 'why_not'));
  assert.notEqual(r.packet.status, 'not_computable', r.text);
  assert.equal(r.packet.status, 'unknown');
  assert.deepEqual(r.packet.missing, [['at_grinder local_sam']]);
  assert.equal(r.packet.route.chosen, 'js-reference');
  assert.match(r.text, /It would follow if .*at grinder.* Sam/);
});

test('a reasoning mode the model surface has no engine for stays not_computable', async t => {
  const r = await turn(t, 'Sam is an apprentice. How does Sam come to wear the shield?', session + stated('s1', 'apprentice', 'Sam') + rule + question('affirmed', 'plan'));
  assert.equal(r.packet.status, 'not_computable');
});

test('explain names the rule it used with its text, not only the facts', async t => {
  const r = await turn(t, 'Sam is an apprentice at the grinder. Why does Sam wear the shield?', session + stated('s1', 'apprentice', 'Sam') + stated('s2', 'at_grinder', 'Sam') + rule + question('affirmed', 'explain'));
  assert.equal(r.packet.status, 'supported', r.text);
  assert.deepEqual(r.packet.rules_used.map(x => [x.id, x.kind, x.conclusion.p, x.conditions.map(c => c.atom.p)]), [['r_shield', 'rule', 'wears_shield', ['apprentice', 'at_grinder']]]);
  assert.match(r.text, /^Yes\./);
  assert.match(r.text, /Rule used, "r_shield": if .*apprentice.* and .*at grinder.*, then .*wears shield/);
});

test('a negated claim over a closed session predicate whose positive form is proved is refuted, not withheld (logic:91)', async t => {
  const sop = session + stated('s1', 'apprentice', 'Sam') + stated('s2', 'at_grinder', 'Sam') + rule;
  const yes = await turn(t, 'Sam is an apprentice at the grinder. Does Sam wear the shield?', sop + question('affirmed'));
  assert.equal(yes.packet.status, 'supported');
  const no = await turn(t, 'Sam is an apprentice at the grinder. May Sam go without the shield?', sop + question('negated'));
  assert.equal(no.packet.status, 'refuted', no.text);
  assert.equal(no.packet.retrieval.guard, 'R-P1 refutation');
  assert.match(no.text, /^No\./);
});

test('abduce of a model query over a memory with hypotheses: the consistent story is given, the contradicted one is rejected (logic:541)', async t => {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  const predicates = ['gate_open', 'padlock_closed', 'tool_marks', 'forced_entry', 'key_entry'];
  const lexicon = new Lexicon('@yard entity\n  label en "yard"\n' + predicates.map(p => `@${p} predicate\n  args subject:entity\n  label en "${p.split('_').join(' ')}"\n`).join(''));
  const circuits = [{name: 'incident.sop', text: predicates.map(p => `@${p} predicate\n  args entity\n`).join('') + INCIDENT}];
  const runtime = new AuthorRuntime({repo: c.repo, session: c.session, lexicon, schema: lexicon.predicates, circuits});
  const sop = stated('s1', 'gate_open', 'yard') + stated('s2', 'padlock_closed', 'yard') + stated('s3', 'tool_marks', 'yard', 'negated')
    + '@q query\n  mode abduce\n  where match\n    relation "gate_open"\n    role subject "yard"\n    polarity affirmed\n  end\n';
  const r = await runtime.run(sop, {origin: 'model', inputText: 'The yard gate was found open, the padlock closed, no tool marks. Which story fits?', language: 'en', context: {}});
  const packet = r.result.packet;
  // the stated observation is what is explained, never its own explanation
  assert.equal(packet.status, 'hypotheses');
  assert.deepEqual(packet.explanations.map(e => e.hypotheses), [['h_key']]);
  assert.deepEqual(packet.inconsistent.map(e => e.contradicts), [['not tool_marks yard']]);
  assert.match(r.result.text, /A possible explanation: .*key entry/);
  assert.match(r.result.text, /Rejected: .*forced entry.*contradict/);
});
