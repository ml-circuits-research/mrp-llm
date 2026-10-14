// Candidates of a query (Q-LANG-10, owner decision 2026-10-03; DS004 "Query modes", DS014 "Candidates: effect and abduce", DS006):
// `candidate $id` names a supposed statement or a session rule/default that is in force only in that query's runs; `mode effect` classifies
// each candidate against a ground claim (establishes, blocks, contradicts, no_effect, inconsistent); `mode abduce` over candidates returns
// the minimal consistent sets plus `necessary`; `if $r` may suppose a session rule. Every validator check, every effect class, the engines'
// honest refusal, the router and the product path (logic book items 171, 91 and 541 as invented SOP programs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {ask} from '../../reasoning/strategies/js-reference/index.mjs';
import {validateProgram} from '../../sop/knowledge/index.mjs';
import {parse} from '../../sop/parser.mjs';
import {checkModelProgram, compileDeclarative} from '../../sop/declarative.mjs';
import {routedAsk} from '../../reasoning/router/index.mjs';
import {prepare} from '../../reasoning/strategies/js-reference/index.mjs';
import {candidatePrograms} from '../../tools/capabilities/l2-generator.mjs';
import {runPrograms} from '../../tools/capabilities/l2-run.mjs';
import {Agent} from '../../server/agent.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {context} from '../helpers.mjs';

// ------------------------------------------------------------------------------------------------ the model surface (validator)

const match = (relation, subject, polarity = 'affirmed') => `match\n    relation "${relation}"\n    role subject ${subject}\n    polarity ${polarity}\n  end`;
const stated = (id, relation, subject, certainty = 'supposed', extra = '') => `@${id} stated\n  certainty ${certainty}\n  relation "${relation}"\n  role subject "${subject}"\n  polarity affirmed\n${extra}`;
const query = (...lines) => '@q query\n' + lines.map(l => '  ' + l + '\n').join('');
const sessionRule = new Map([['r_conv', 'rule'], ['d_late', 'default'], ['p_wet', 'predicate']]);
const model = (text, definitions = new Map()) => checkModelProgram(parse(text), {definitions});

test('validator: candidate lines belong to mode effect or abduce (candidate_needs_mode)', () => {
  assert.throws(() => model(stated('s1', 'rain', 'Paris') + query('where ' + match('wet', '"Paris"'), 'candidate $s1')), /candidate_needs_mode/);
  assert.throws(() => model(stated('s1', 'rain', 'Paris') + query('mode exists', 'where ' + match('wet', '"Paris"'), 'candidate $s1')), /candidate_needs_mode/);
  assert.doesNotThrow(() => model(stated('s1', 'rain', 'Paris') + query('mode abduce', 'where ' + match('wet', '"Paris"'), 'candidate $s1')));
});

test('validator: mode effect needs a ground claim and at least one candidate (effect_needs_ground_claim)', () => {
  assert.throws(() => model(query('mode effect', 'where ' + match('wet', '"Paris"'))), /effect_needs_ground_claim/);
  assert.throws(() => model(stated('s1', 'rain', 'Paris') + query('mode effect', 'where ' + match('wet', '?x'), 'candidate $s1')), /effect_needs_ground_claim/);
  assert.throws(() => model(stated('s1', 'rain', 'Paris') + query('mode effect', 'where ' + match('wet', '?x'), 'select ?x', 'candidate $s1')), /effect_needs_ground_claim/);
  assert.doesNotThrow(() => model(stated('s1', 'rain', 'Paris') + query('mode effect', 'where ' + match('wet', '"Paris"'), 'candidate $s1')));
});

test('validator: a candidate names a supposed statement or a session rule or default of the output (candidate_target)', () => {
  const claim = 'where ' + match('wet', '"Paris"');
  assert.throws(() => model(stated('s1', 'rain', 'Paris', 'asserted') + query('mode effect', claim, 'candidate $s1')), /candidate_target: .*not certainty supposed/);
  assert.throws(() => model(query('mode effect', claim, 'candidate $r_none')), /candidate_target: .*names no wire/);
  assert.throws(() => model(query('mode effect', claim, 'candidate $p_wet'), sessionRule), /candidate_target: .*session predicate/);
  assert.throws(() => model(query('mode effect', claim, 'candidate r_conv'), sessionRule), /candidate_target: .*exactly one \$id/);
  assert.throws(() => model(stated('s1', 'rain', 'Paris') + query('mode effect', claim, 'candidate $s1', 'candidate $s1')), /candidate_target: .*twice/);
  assert.doesNotThrow(() => model(query('mode effect', claim, 'candidate $r_conv', 'candidate $d_late'), sessionRule));
});

test('validator: a wire is not both a candidate and an if condition (candidate_also_if)', () => {
  assert.throws(() => model(stated('s1', 'rain', 'Paris') + query('mode effect', 'where ' + match('wet', '"Paris"'), 'candidate $s1', 'if $s1')), /candidate_also_if/);
  assert.throws(() => model(query('mode effect', 'where ' + match('wet', '"Paris"'), 'candidate $r_conv', 'if $r_conv'), sessionRule), /candidate_also_if/);
});

test('validator: at most eight candidates per query (candidate_limit)', () => {
  const nine = Array.from({length: 9}, (_, i) => stated('s' + i, 'rain', 'City' + i)).join('');
  const lines = Array.from({length: 9}, (_, i) => 'candidate $s' + i);
  assert.throws(() => model(nine + query('mode abduce', 'where ' + match('wet', '"Paris"'), ...lines)), /candidate_limit/);
  assert.doesNotThrow(() => model(nine + query('mode abduce', 'where ' + match('wet', '"Paris"'), ...lines.slice(0, 8))));
});

test('validator: temporal links do not combine with candidates (candidate_temporal_link)', () => {
  const clause = stated('s9', 'open', 'Acme', 'asserted', '  role time "2020"\n');
  assert.throws(() => model(stated('s1', 'rain', 'Paris') + clause + query('mode effect', 'where ' + match('wet', '"Paris"'), 'candidate $s1', 'before $s9')), /candidate_temporal_link/);
});

test('validator: if may suppose a session rule, only with if on a query', () => {
  const ask = query('where ' + match('wet', '"Paris"'), 'if $r_conv');
  assert.doesNotThrow(() => model(ask, sessionRule));
  assert.throws(() => model(ask), /link_reference_unknown/, 'without the definitions the rule is unknown');
  assert.throws(() => model(query('where ' + match('wet', '"Paris"'), 'because $r_conv'), sessionRule), /link_target_type: .*only `if` on a query/);
});

// ------------------------------------------------------------------------------------------------ the knowledge surface (validator)

const K = '@p predicate\n  args subject:entity\n@q predicate\n  args subject:entity\n@r1 rule\n  when p ?x\n  then q ?x\n  approval proposed\n';
const codes = queryText => validateProgram([{name: 'k', text: K, role: 'knowledge'}, {name: 'q', text: queryText, role: 'query'}]).problems.map(p => p.code);

test('knowledge validator: the same five checks on the oracle language', () => {
  assert.deepEqual(codes('@w query\n  mode effect\n  where q a\n  candidate $r1\n'), []);
  assert.ok(codes('@s fact\n  holds p a\n  status supposed\n@w query\n  where q a\n  candidate $s\n').includes('candidate_needs_mode'));
  assert.ok(codes('@w query\n  mode effect\n  where q ?x\n  candidate $r1\n').includes('effect_needs_ground_claim'));
  assert.ok(codes('@w query\n  mode effect\n  where q a\n').includes('effect_needs_ground_claim'));
  assert.ok(codes('@w query\n  mode effect\n  where q a\n  candidate $p\n').includes('candidate_target'));
  assert.ok(codes('@w query\n  mode effect\n  where q a\n  candidate $r1\n  if $r1\n').includes('candidate_also_if'));
  const nine = Array.from({length: 9}, (_, i) => `@s${i} fact\n  holds p e${i}\n  status supposed\n`).join('');
  assert.ok(codes(nine + '@w query\n  mode abduce\n  where q a\n' + Array.from({length: 9}, (_, i) => `  candidate $s${i}\n`).join('')).includes('candidate_limit'));
});

// ------------------------------------------------------------------------------------------------ the oracle: every effect class

const oracle = (knowledge, q) => ask({theory: {knowledge}, query: q});
const effects = r => Object.fromEntries(r.effects.map(e => [e.candidate, e.effect]));
const BIRD = '@bird predicate\n  args subject:entity\n@flies predicate\n  args subject:entity\n@injured predicate\n  args subject:entity\n@f1 fact\n  holds bird tweety\n';
const sup = (id, atom) => `@${id} fact\n  holds ${atom}\n  status supposed\n`;

test('effect: establishes (logic:171, the converse of the card rule makes "it rained" follow)', () => {
  const k = '@rained predicate\n  args subject:entity\n@wet predicate\n  args subject:entity\n@f1 fact\n  holds wet market\n@r_card rule\n  when rained ?m\n  then wet ?m\n@r_conv rule\n  when wet ?m\n  then rained ?m\n  approval proposed\n';
  const r = oracle(k, '@q query\n  mode effect\n  where rained market\n  candidate $r_conv\n');
  assert.equal(r.status, 'unknown', 'the claim does not follow from the card');
  assert.deepEqual(r.effects.map(e => [e.candidate, e.kind, e.baseline, e.with, e.effect]), [['r_conv', 'rule', 'unknown', 'supported', 'establishes']]);
  assert.ok(r.effects[0].used.some(u => u.id === 'r_conv'));
});

test('effect: blocks (an exception of a default), contradicts (a strict contrary: refuted; a strict rule against a strict rule: both)', () => {
  const k = BIRD + '@d_flies default\n  when bird ?x\n  then flies ?x\n  except injured ?x\n@r_never rule\n  when bird ?x\n  then not flies ?x\n  approval proposed\n';
  const r = oracle(k, sup('s_injured', 'injured tweety') + '@q query\n  mode effect\n  where flies tweety\n  candidate $s_injured\n  candidate $r_never\n');
  assert.equal(r.status, 'supported');
  assert.deepEqual(effects(r), {s_injured: 'blocks', r_never: 'contradicts'});
  assert.deepEqual(r.effects.map(e => e.with), ['unknown', 'refuted']);
  const both = oracle(BIRD + '@r_flies rule\n  when bird ?x\n  then flies ?x\n@r_never rule\n  when bird ?x\n  then not flies ?x\n  approval proposed\n', '@q query\n  mode effect\n  where flies tweety\n  candidate $r_never\n');
  assert.deepEqual(both.effects.map(e => [e.with, e.effect]), [['both', 'contradicts']]);
});

test('effect: no_effect (logic:91, darkness does not touch Rule One) and inconsistent (a supposition contradicted by what is known)', () => {
  const k = '@apprentice predicate\n  args subject:entity\n@at_grinder predicate\n  args subject:entity\n@dark predicate\n  args subject:entity\n@wears_shield predicate\n  args subject:entity\n'
    + '@f1 fact\n  holds apprentice sam\n@f2 fact\n  holds at_grinder sam\n@r_one rule\n  when apprentice ?x\n  when at_grinder ?x\n  then wears_shield ?x\n';
  const r = oracle(k, sup('s_dark', 'dark depot') + sup('s_not', 'not apprentice sam') + '@q query\n  mode effect\n  where wears_shield sam\n  candidate $s_dark\n  candidate $s_not\n');
  assert.equal(r.status, 'supported');
  assert.deepEqual(effects(r), {s_dark: 'no_effect', s_not: 'inconsistent'});
  assert.deepEqual(r.effects[1].contradicts, ['apprentice sam']);
});

test('effect: a rule candidate whose consequences contradict an admitted fact is inconsistent, not counted (logic:541)', () => {
  const k = '@gate_open predicate\n  args subject:entity\n@tool_marks predicate\n  args subject:entity\n@forced predicate\n  args subject:entity\n@f1 fact\n  holds forced yard\n@f2 fact\n  holds not tool_marks yard\n'
    + '@r_open rule\n  when forced ?s\n  then gate_open ?s\n@r_marks rule\n  when forced ?s\n  then tool_marks ?s\n  approval proposed\n';
  const r = oracle(k, '@q query\n  mode effect\n  where gate_open yard\n  candidate $r_marks\n');
  assert.deepEqual(r.effects.map(e => [e.effect, e.contradicts]), [['inconsistent', ['not tool_marks yard']]]);
});

test('effect: a candidate is in force only in its own run, and an approved rule named as a candidate leaves the baseline', () => {
  const k = BIRD + '@r_flies rule\n  when bird ?x\n  then flies ?x\n';
  const r = oracle(k, '@q query\n  mode effect\n  where flies tweety\n  candidate $r_flies\n');
  assert.deepEqual([r.status, r.effects[0].effect], ['unknown', 'establishes']);
  // the supposed fact named as a candidate is no assumption of the answer (no conditional runs over it)
  const s = oracle(BIRD + '@d_flies default\n  when bird ?x\n  then flies ?x\n  except injured ?x\n', sup('s_injured', 'injured tweety') + '@q query\n  mode effect\n  where flies tweety\n  candidate $s_injured\n');
  assert.equal(s.status, 'supported');
  assert.equal(s.conditional, undefined);
});

test('effect: a closed predicate keeps its absence semantics; a candidate fact of it blocks a conclusion that rests on the absence', () => {
  const k = '@student predicate\n  args subject:entity\n@late predicate\n  args subject:entity\n  closed true\n@gets_pass predicate\n  args subject:entity\n@f1 fact\n  holds student ana\n'
    + '@r_pass rule\n  when student ?x\n  when absent late ?x\n  then gets_pass ?x\n';
  const r = oracle(k, sup('s_late', 'late ana') + '@q query\n  mode effect\n  where gets_pass ana\n  candidate $s_late\n');
  assert.deepEqual([r.status, effects(r)], ['supported', {s_late: 'blocks'}]);
});

test('abduce over candidates: minimal consistent sets and the necessary candidates (logic:541; a rule and a fact needed together)', () => {
  const k = '@gate_open predicate\n  args subject:entity\n@tool_marks predicate\n  args subject:entity\n@forced predicate\n  args subject:entity\n@key predicate\n  args subject:entity\n'
    + '@f2 fact\n  holds not tool_marks yard\n@r1 rule\n  when forced ?s\n  then gate_open ?s\n@r2 rule\n  when forced ?s\n  then tool_marks ?s\n@r3 rule\n  when key ?s\n  then gate_open ?s\n';
  const r = oracle(k, sup('s_forced', 'forced yard') + sup('s_key', 'key yard') + '@q query\n  mode abduce\n  where gate_open yard\n  candidate $s_forced\n  candidate $s_key\n');
  assert.equal(r.status, 'hypotheses');
  assert.deepEqual(r.explanations.map(e => e.hypotheses), [['s_key']]);
  assert.deepEqual(r.inconsistent.map(e => [e.hypotheses, e.contradicts]), [[['s_forced'], ['not tool_marks yard']]]);
  assert.deepEqual(r.necessary, ['s_key']);
  const both = oracle('@wet predicate\n  args subject:entity\n@rained predicate\n  args subject:entity\n@cloudy predicate\n  args subject:entity\n@f1 fact\n  holds wet market\n@r_rain rule\n  when wet ?m\n  when cloudy ?m\n  then rained ?m\n  approval proposed\n',
    sup('s_cloudy', 'cloudy market') + '@q query\n  mode abduce\n  where rained market\n  candidate $r_rain\n  candidate $s_cloudy\n');
  assert.deepEqual([both.explanations.map(e => e.hypotheses), both.necessary], [[['r_rain', 's_cloudy']], ['r_rain', 's_cloudy']]);
});

test('oracle: the validator checks hold on a direct call too, and a candidate is never an assumption', () => {
  assert.throws(() => oracle(BIRD, '@q query\n  mode effect\n  where flies tweety\n'), /effect_needs_ground_claim/);
  assert.throws(() => oracle(BIRD + sup('s', 'injured tweety'), '@q query\n  where flies tweety\n  candidate $s\n'), /candidate_needs_mode/);
  assert.throws(() => oracle(BIRD, '@q query\n  mode effect\n  where flies ?x\n  candidate $f1\n'), /effect_needs_ground_claim|candidate_target/);
  assert.throws(() => oracle(BIRD, '@q query\n  mode effect\n  where flies tweety\n  candidate $f1\n'), /candidate_target/);
});

test('engines: every wire engine refuses candidates honestly; the router sends mode effect to the oracle', async () => {
  const programs = candidatePrograms();
  assert.ok(programs.length >= 10);
  const results = await runPrograms(programs.slice(0, 3));
  for (const r of results) {
    assert.ok(!r.oracle.error, r.id + ': ' + r.oracle.error);
    for (const [engine, outcome] of Object.entries(r.outcomes)) assert.ok(['n', 'u'].includes(outcome), `${r.id} ${engine}: ${outcome}`);
  }
  const p = programs.find(x => x.id.startsWith('q:logic171-effect'));
  const routed = routedAsk({handle: prepare({knowledge: p.knowledge}), query: p.query, requested: 'auto'});
  assert.equal(routed.route.chosen, 'js-reference');
  assert.equal(routed.route.rule, 'proof_or_mode_of_work');
  assert.equal(routed.effects[0].effect, 'establishes');
  const explicit = routedAsk({handle: prepare({knowledge: p.knowledge}), query: p.query, requested: 'sql-sqlite'});
  assert.equal(explicit.status, 'unsupported', 'an explicitly requested engine is never substituted');
});

// ------------------------------------------------------------------------------------------------ the product path (Agent.turn)

async function turn(t, message, sop) {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  const agent = new Agent({repo: c.repo, session: c.session, lexicon: new Lexicon('@works_at predicate\n  args subject:entity object:entity\n'), config: {}});
  return agent.turn(message, {language: 'en', formalizer: {formalize: async () => sop}});
}
const modelStated = (id, relation, subject, {certainty = 'asserted', polarity = 'affirmed'} = {}) => `@${id} stated\n  certainty ${certainty}\n  relation "${relation}"\n  role subject "${subject}"\n  polarity ${polarity}\n`;
const RAIN = '@rained predicate\n  args subject:entity\n@pavement_wet predicate\n  args subject:entity\n@r_card rule\n  when rained ?m\n  then pavement_wet ?m\n@r_converse rule\n  when pavement_wet ?m\n  then rained ?m\n';

test('product: logic:171 as mode effect, the converse rule establishes the claim and never joins the session', async t => {
  const sop = RAIN + modelStated('s1', 'pavement_wet', 'market') + `@q_sam query\n  mode effect\n  candidate $r_converse\n  where ${match('rained', '"market"')}\n`;
  const r = await turn(t, 'If it rained at the market, the pavement there is wet. The pavement at the market is wet. Sam says: so it rained.', sop);
  assert.equal(r.packet.status, 'unknown', r.text);
  assert.deepEqual(r.packet.effects.map(e => [e.candidate, e.kind, e.effect]), [['r_converse', 'rule', 'establishes']]);
  assert.equal(r.packet.route.chosen, 'js-reference');
  assert.match(r.text, /^Without any of the options, it does not follow from what is known\./);
  assert.match(r.text, /With the rule "r_converse" \(if .*pavement wet.*, then .*rained.*\), it would follow\./);
  assert.doesNotMatch(r.packet.session_circuits.text, /r_converse/, 'a hypothetical rule is never stored');
  assert.match(r.packet.session_circuits.text, /r_card/);
});

test('product: if $r supposes a session rule for one question only', async t => {
  const sop = RAIN + modelStated('s1', 'pavement_wet', 'market') + `@q1 query\n  if $r_converse\n  where ${match('rained', '"market"')}\n@q2 query\n  where ${match('rained', '"market"')}\n`;
  const r = await turn(t, 'The pavement at the market is wet. If wet pavement meant rain, did it rain at the market? And did it rain at the market?', sop);
  const [first, second] = r.text.split(/\n\nq2:\n/);
  assert.match(first, /^q1:\n.*assumptions.*\nYes\./, r.text);
  assert.match(first, /definition by coding agent \(r_converse\)/);
  assert.match(second, /I don't know/, 'the rule is not in force for the other question');
});

test('product: logic:91 as mode effect over a supposed statement: darkness has no effect on the rule', async t => {
  const sop = '@apprentice predicate\n  args subject:entity\n@at_grinder predicate\n  args subject:entity\n@dark predicate\n  args subject:entity\n@wears_shield predicate\n  args subject:entity\n'
    + '@r_shield rule\n  when apprentice ?x\n  when at_grinder ?x\n  then wears_shield ?x\n'
    + modelStated('s1', 'apprentice', 'Sam') + modelStated('s2', 'at_grinder', 'Sam') + modelStated('s_dark', 'dark', 'depot', {certainty: 'supposed'})
    + `@q query\n  mode effect\n  candidate $s_dark\n  where ${match('wears_shield', '"Sam"')}\n`;
  const r = await turn(t, 'Sam is an apprentice at the grinder. Tess says Sam may skip the shield because the depot is dark.', sop);
  assert.equal(r.packet.status, 'supported', r.text);
  assert.deepEqual(r.packet.effects.map(e => [e.candidate, e.kind, e.effect]), [['s_dark', 'fact', 'no_effect']]);
  assert.match(r.text, /^Without any of the options, it follows from what is known\./);
  assert.match(r.text, /Depot .*changes nothing about it\./i);
});

test('product: logic:541 as abduce over candidate statements: the key story fits, forced entry is rejected, the key is necessary', async t => {
  const preds = ['gate_open', 'padlock_closed', 'tool_marks', 'forced_entry', 'key_entry'].map(p => `@${p} predicate\n  args subject:entity\n`).join('');
  const rules = '@r_forced_open rule\n  when forced_entry ?s\n  then gate_open ?s\n@r_forced_marks rule\n  when forced_entry ?s\n  then tool_marks ?s\n@r_key_open rule\n  when key_entry ?s\n  then gate_open ?s\n';
  const sop = preds + rules + modelStated('s1', 'gate_open', 'yard') + modelStated('s2', 'padlock_closed', 'yard') + modelStated('s3', 'tool_marks', 'yard', {polarity: 'negated'})
    + modelStated('s_forced', 'forced_entry', 'yard', {certainty: 'supposed'}) + modelStated('s_key', 'key_entry', 'yard', {certainty: 'supposed'})
    + `@q query\n  mode abduce\n  candidate $s_forced\n  candidate $s_key\n  where ${match('gate_open', '"yard"')}\n`;
  const r = await turn(t, 'The yard gate was found open, the padlock closed, no tool marks. Was it forced entry, or did someone use the key?', sop);
  assert.equal(r.packet.status, 'hypotheses', r.text);
  assert.deepEqual(r.packet.explanations.map(e => e.hypotheses), [['s_key']]);
  assert.deepEqual(r.packet.inconsistent.map(e => e.hypotheses), [['s_forced']]);
  assert.deepEqual(r.packet.necessary, ['s_key']);
  assert.match(r.text, /A possible explanation: .*key entry/);
  assert.match(r.text, /Rejected: .*forced entry.*contradict/);
  assert.match(r.text, /Every explanation needs .*key entry/);
});

test('product: a runtime without hypothetical runs reports a candidate question not_computable, never answers it without its candidates', () => {
  const plan = compileDeclarative(stated('s1', 'rain', 'Paris') + query('mode effect', 'where ' + match('wet', '"Paris"'), 'candidate $s1'), {lexicon: null});
  assert.deepEqual(plan.notComputable.map(x => x.declaration), ['q']);
});
