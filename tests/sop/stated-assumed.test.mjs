// DS014: the context-free model language (stated, assumed, unclear,
// query with match blocks, constraint): parser shape, host linking, compiler
// admission and host semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, canonical, SPEC, ROLE_NAMES} from '../../sop/parser.mjs';
import {compileDeclarative, MODEL_TYPES} from '../../sop/declarative.mjs';
import {propositionOf, propositionKey, linkProposition} from '../../sop/propositions.mjs';
import {linkRelation, normalizeTime, mentionedIn, phraseKey} from '../../sop/linking.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {GRAMMAR} from '../../sop/knowledge/grammar.mjs';
import {validateProgram} from '../../sop/knowledge/index.mjs';
import {UNCLEAR_KINDS} from '../../sop/unclear.mjs';
import {assertReply} from '../helpers.mjs';
import {context, lex, schema} from '../helpers.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
/** One keyword-line proposition over the relation "works at". */
function prop(id, type, {relation = '"works at"', roles = [['subject', '"Maria"'], ['object', '"Alpha Lab"']], polarity = 'affirmed', valid = [], extra = type === 'stated' ? ['certainty asserted'] : []} = {}) {
  return [`@${id} ${type}`, `  relation ${relation}`, ...roles.map(([name, value]) => `  role ${name} ${value}`), ...(polarity ? [`  polarity ${polarity}`] : []), ...valid.map(v => `  valid ${v}`), ...extra.map(line => '  ' + line)].join('\n') + '\n';
}
const match = (subject, object, polarity = 'affirmed', relation = '"works at"') => `  where match\n    relation ${relation}\n    role subject ${subject}\n    role object ${object}\n    polarity ${polarity}\n  end\n`;
const question = '@q query\n' + match('"Maria"', '"Alpha Lab"');
const compile = (source, options = {}) => compileDeclarative(source, {lexicon: lex, schema, now: NOW, ...options});
const runtime = (policy = {}, c = null) => new Runtime({lexicon: lex, schema, now: NOW, policy, ...(c ? {repo: c.repo, session: c.session} : {})});

test('model types: stated/assumed/unclear/query/constraint/unparsed/pragmatic/instruction only', () => {
  assert.deepEqual([...MODEL_TYPES], ['stated', 'assumed', 'unclear', 'query', 'constraint', 'unparsed', 'pragmatic', 'instruction']);
  for (const source of ['@x jsEval\n  expr 1 + 2', '@x value\n  data 1 + 2', '@x clarify\n  text "Which?"', '@x fact\n  holds works_at maria lab_alpha\n  valid timeless'])
    assert.throws(() => compile(source), /belongs to symbolic execution/, source);
  // Queries state conditions as string match blocks, never atoms.
  assert.throws(() => compile('@q query\n  where works_at maria lab_alpha'), /query_needs_match/);
  assert.throws(() => compile(question + '  at 2026-01-01\n'), /at takes a JSON-quoted temporal expression/);
});

test('parser: strings as written, a closed role inventory, explicit polarity, quoted validity', () => {
  assert.deepEqual(SPEC.stated.required, ['relation', 'role', 'polarity', 'certainty']);
  assert.deepEqual(SPEC.assumed.required, ['relation', 'role', 'polarity']);
  assert.deepEqual(SPEC.unclear.required, ['kind']);
  assert.deepEqual([...ROLE_NAMES], ['subject', 'object', 'recipient', 'location', 'source', 'destination', 'instrument', 'time', 'topic']);
  const rejects = [
    [prop('s', 'stated', {polarity: null}), /needs polarity/],
    [prop('s', 'stated', {extra: []}), /needs certainty/],
    [prop('s', 'stated', {extra: ['certainty sure']}), /certainty must be asserted, hedged or supposed/],
    [prop('s', 'stated', {polarity: 'maybe'}), /polarity must be affirmed or negated/],
    [prop('s', 'stated', {relation: 'works_at'}), /relation takes one JSON-quoted string/],
    [prop('s', 'stated', {relation: '""'}), /nonempty quoted string/],
    [prop('s', 'stated', {extra: ['certainty asserted', 'basis world']}), /Unsupported field basis on stated/],
    [prop('s', 'stated', {extra: ['certainty asserted', 'quote "Maria works at Alpha Lab"']}), /Unsupported field quote on stated/],
    [prop('s', 'stated', {extra: ['certainty asserted', 'holds works_at maria lab_alpha']}), /Unsupported field holds on stated/],
    [prop('s', 'stated', {extra: ['certainty asserted', 'speaker ion']}), /speaker must be user or a JSON-quoted name/],
    [prop('a', 'assumed', {extra: ['certainty hedged']}), /Unsupported field certainty on assumed/],
    [prop('a', 'assumed', {extra: ['basis guess']}), /basis must be one of/],
    [prop('s', 'stated', {roles: [['employee', '"Maria"'], ['object', '"Alpha Lab"']]}), /role_unknown: .* role employee is not one of subject, object/],
    [prop('s', 'stated', {roles: [['subject', '"Maria"'], ['subject', '"Ana"']]}), /role_duplicate/],
    [prop('s', 'stated', {roles: [['subject', '~who'], ['object', '"Alpha Lab"']]}), /proposition_not_ground/],
    [prop('s', 'stated', {roles: [['subject', '"?who"'], ['object', '"Alpha Lab"']]}), /proposition_not_ground/],
    [prop('s', 'stated', {roles: [['subject', 'maria'], ['object', '"Alpha Lab"']]}), /value must be a JSON-quoted string as written in the message/],
    [prop('s', 'stated', {roles: [['subject', '"Maria" extra'], ['object', '"Alpha Lab"']]}), /role takes exactly NAME VALUE/],
    [prop('s', 'stated', {valid: ['since "2025"']}), /time_form: .* valid takes on\|from\|until "text"/],
    [prop('s', 'stated', {valid: ['from 2025']}), /valid from takes one JSON-quoted string/],
    [prop('s', 'stated', {valid: ['on "2026-03-03"', 'from "2026"']}), /valid on excludes valid from\/until/],
    [prop('s', 'stated', {valid: ['from "2025"', 'from "2026"']}), /repeats valid from/],
    ['@q query\n  where match\n    relation "works at"\n    role subject ?who\n  end', /needs polarity/],
    ['@q query\n  where match\n    relation "works at"\n    role subject ?who\n    polarity affirmed\n    certainty asserted\n  end', /Unsupported field certainty in @q match/],
    ['@u unclear\n  kind contradictory', /unclear kind must be one of gibberish, no_request/],
    ['@u unclear\n  kind gibberish\n  language de', /unclear language must be one of en/],
  ];
  for (const [source, error] of rejects) assert.throws(() => parse(source), error, source);
  // A ?variable in a statement is only a placeholder paired with an unparsed span, and a $id names a wire of the
  // output; both parse and are rejected at admission when they are not (DS014 "Honest partial formalization").
  assert.throws(() => compile(prop('s', 'stated', {roles: [['subject', '?who'], ['object', '"Alpha Lab"']]})), /proposition_not_ground: .*unknowns belong in a query/);
  assert.throws(() => compile(prop('s', 'stated', {roles: [['subject', '$who'], ['object', '"Alpha Lab"']]})), /reference_unknown/);
  assert.doesNotThrow(() => parse(prop('s', 'stated', {valid: ['from "2025"', 'until "2026"'], extra: ['certainty supposed', 'speaker "Ana"']})));
  assert.doesNotThrow(() => parse(prop('s', 'stated', {relation: '"takes minutes"', roles: [['subject', '"the check"'], ['object', '5']]})));
  assert.equal(canonical(parse(question)), question, 'a match block has a canonical form');
});

test('host linking: relation phrases, role sets, fresh query variables, times and anchoring', () => {
  assert.equal(phraseKey('is working at'), phraseKey('working at'));
  assert.equal(phraseKey('works at'), phraseKey('work at'));
  assert.equal(phraseKey('Is a parent of'), phraseKey('parent of'));
  assert.deepEqual(linkRelation('work at', ['subject', 'object'], lex), {status: 'bound', text: 'work at', id: 'works_at', roles: ['subject', 'object'], types: ['person', 'organization'], score: 100, tier: 100, decided_by: 'only_candidate', scored_alternatives: []});
  assert.equal(linkRelation('toil at', ['subject', 'object'], lex).status, 'unknown', 'only reviewed English forms link');
  assert.equal(linkRelation('lucrează la', ['subject', 'object'], lex).status, 'unknown', 'the core holds English forms only');
  assert.equal(linkRelation('flies to', ['subject', 'object'], lex).status, 'unknown');
  assert.equal(linkRelation('work at', ['subject'], lex).status, 'role_mismatch', 'a statement binds every declared role');
  assert.equal(linkRelation('work at', ['subject'], lex, {exact: false}).status, 'bound', 'a query may leave roles unbound');
  const twin = new Lexicon('@runs_company predicate\n  role subject person\n  role object organization\n  label en "runs"\n@runs_route predicate\n  role subject person\n  role location place\n  label en "runs"\n@runs_team predicate\n  role subject person\n  role object organization\n  label en "leads"\n  label en "runs"');
  assert.equal(linkRelation('runs', ['subject', 'location'], twin).id, 'runs_route', 'the role set disambiguates');
  assert.deepEqual(linkRelation('runs', ['subject', 'object'], twin).candidates.map(c => c.id), ['runs_company', 'runs_team']);
  const p = propositionOf(parse('@q stated\n  relation "takes minutes"\n  role subject "the check"\n  role object "5"\n  polarity affirmed\n  certainty asserted').wires[0]);
  assert.equal(linkProposition(p, lex).atomText, 'duration "the check" 5', 'a numeral fills an integer argument');
  const pattern = propositionOf(parse(prop('s', 'stated', {polarity: 'negated', roles: [['object', '"Alpha Lab"'], ['subject', '"Maria"']]})).wires[0]);
  assert.equal(linkProposition(pattern, lex).atomText, 'not works_at "Maria" "Alpha Lab"', 'roles are ordered by the predicate');
  assert.deepEqual(normalizeTime('2025', NOW), {from: Date.parse('2025-01-01'), until: Date.parse('2026-01-01')});
  assert.deepEqual(normalizeTime('in March 2026', NOW), {from: Date.parse('2026-03-01'), until: Date.parse('2026-04-01')});
  assert.deepEqual(normalizeTime('March 2026', NOW), {from: Date.parse('2026-03-01'), until: Date.parse('2026-04-01')});
  assert.deepEqual(normalizeTime('yesterday', NOW), {from: Date.parse('2026-09-25'), until: Date.parse('2026-09-26')});
  assert.deepEqual(normalizeTime('2026-03-03', NOW), {from: Date.parse('2026-03-03'), until: Date.parse('2026-03-04')});
  assert.equal(normalizeTime('last spring', NOW), null);
  assert.equal(normalizeTime('2026-02-30', NOW), null);
  for (const [value, message, expected] of [['Maria', 'Mariei îi place Alfa', true], ['Alpha Lab', 'Does Maria work at Alpah Lab?', true], ['Laboratorul Alfa', 'la laboratorul alfa', true], ['5', 'it takes 5 minutes', true], ['Bogdan', 'Maria works at Alpha Lab', false], ['Ana', 'Anastasia', false]])
    assert.equal(mentionedIn(value, message), expected, `${value} in ${message}`);
});

test('lexicon: roles from the closed inventory, subject/object by position, strict ontology SPEC', () => {
  assert.deepEqual(lex.predicates.works_at.roles, [{name: 'subject', type: 'person'}, {name: 'object', type: 'organization'}]);
  assert.deepEqual(lex.predicates.works_at.args, ['person', 'organization']);
  assert.deepEqual(lex.predicates.located_in.roles.map(r => r.name), ['subject', 'location']);
  const legacy = new Lexicon('@p predicate\n  args person place\n@q predicate\n  args entity entity entity');
  assert.deepEqual(legacy.predicates.p.roles.map(role => role.name), ['subject', 'object']);
  assert.equal(legacy.predicates.p.namedRoles, false);
  assert.deepEqual(legacy.predicates.q.roles, [], 'an unnamed predicate of arity three cannot be linked');
  assert.equal(linkRelation('q', ['subject', 'object', 'recipient'], legacy).status, 'role_mismatch');
  assert.deepEqual(GRAMMAR.predicate.fields.role.card, 'many');
  const codes = text => validateProgram([{name: 'k', text, role: 'knowledge'}]).problems.map(p => p.code);
  assert.ok(codes('@p predicate\n  role employee person').includes('bad_role'), 'a role is one of the closed inventory');
  assert.ok(codes('@person entity\n  kind class\n  label en "person"\n@place entity\n  kind class\n  label en "place"\n@p predicate\n  role subject person\n  role subject place').includes('duplicate_role'));
  assert.ok(codes('@person entity\n  kind class\n  label en "person"\n@p predicate\n  role subject person\n  args place').includes('bad_args'));
  assert.ok(codes('@p predicate\n  role subject entity\n  colour red').includes('unknown_field'), 'the grammar rejects every keyword it does not list');
  assert.ok(codes('@e entity\n  kind person\n  kind place').includes('repeated_field'));
  assert.ok(codes('@c concept\n  is_a thing\n  args x').includes('unknown_wire_type'), 'the former concept wire is a class entity now');
  assert.ok(codes('@p predicate\n  label en "p"').includes('missing_field'));
});

test('compiler: duplicates, redundant assumptions, assumption budget, unclear alone and constraint task', () => {
  assert.throws(() => compile(prop('s1', 'stated') + prop('s2', 'stated', {roles: [['object', '"alpha lab"'], ['subject', '"MARIA"']]}) + question), /stated_duplicate/);
  assert.doesNotThrow(() => compile(prop('s1', 'stated') + prop('s2', 'stated', {polarity: 'negated'}) + question), 'contrary statements are accepted and reported as a conflict');
  assert.throws(() => compile(prop('s1', 'stated') + prop('a1', 'assumed') + question), /assumed_duplicates_stated/);
  assert.doesNotThrow(() => compile(prop('s1', 'stated') + prop('a1', 'assumed', {polarity: 'negated'}) + question));
  const many = ['Ana', 'Maria', 'Carina'].map((who, i) => prop('a' + i, 'assumed', {roles: [['subject', `"${who}"`], ['object', '"Alpha Lab"']]})).join('');
  assert.throws(() => compile(many + question, {maxModelAssumptions: 2}), /too_many_assumptions/);
  assert.throws(() => compile('@u unclear\n  kind gibberish\n' + question), /unclear_not_alone/);
  assert.equal(compile('@u unclear\n  kind no_request').unclear.kind, 'no_request');
  assert.throws(() => compile('@c constraint\n  var ?x int 0 3\n  claim ?x at_least 1'), /constraint_task_required/);
  assert.throws(() => compile(prop('a', 'assumed') + question, {modelAssumptions: 'use'}), /report or branch/);
});

test('an asserted statement is turn-local user evidence: linked by the host, not hypothetical, never stored', async () => {
  const c = context({bootstrap: false});
  try {
    const out = await runtime({}, c).run(prop('s1', 'stated') + '@q query\n' + match('?who', '"Alpha Lab"') + '  select ?who\n', {origin: 'model', inputText: 'Maria works at Alpha Lab. Who works at Alpha Lab?'});
    assert.equal(out.result.packet.status, 'supported');
    assert.equal(out.result.packet.hypothetical, false);
    assert.deepEqual(out.result.packet.answers.map(a => a.binding), [{'?who': 'maria'}]);
    assert.match(out.executionSop, /@\w+ resolve\n  text "Maria"\n  language en\n  kind entity\n  type person/);
    assert.match(out.executionSop, /@s1 fact\n  holds works_at \$\w+ \$\w+\n  valid timeless\n  source user/);
    assert.match(out.executionSop, /data \$s1/);
    assert.equal(out.result.packet.reinforcement, undefined);
    assert.equal(Object.keys(c.session.live.claims).length, 0);
    const [statement] = out.result.packet.user_statements;
    assert.deepEqual([statement.predicate, statement.atom, statement.certainty, statement.speaker, statement.treatment], ['works_at', 'works_at maria lab_alpha', 'asserted', 'user', 'evidence']);
    assert.equal(statement.statement, 'You stated: works at (subject: Maria; object: Alpha Lab).');
  } finally { c.dispose(); }
});

test('hedged, supposed and reported statements run conditionally and are marked as such', async () => {
  for (const [extra, lead] of [[['certainty hedged'], /^You stated tentatively/], [['certainty supposed'], /^You supposed/], [['certainty asserted', 'speaker "Ana"'], /^According to Ana/]]) {
    const out = await runtime().run(prop('s1', 'stated', {extra}) + question, {origin: 'model'});
    assert.equal(out.result.packet.status, 'supported', extra.join());
    assert.equal(out.result.packet.hypothetical, true, extra.join());
    assert.match(out.executionSop, /@s1 fact\n  holds works_at \$\w+ \$\w+\n  valid timeless\n  source assumption/);
    const [statement] = out.result.packet.user_statements;
    assert.equal(statement.treatment, 'supposition');
    assert.equal(statement.used_in_proof, true);
    assert.match(statement.statement, lead);
    assert.match(out.result.text, /This result depends on the stated assumptions/);
    assert.ok(out.result.text.includes('Condition: ' + statement.statement));
  }
  const defeated = await runtime().run(prop('s1', 'stated', {extra: ['certainty supposed']}) + prop('s2', 'stated', {polarity: 'negated'}) + question, {origin: 'model'});
  assert.equal(defeated.result.packet.status, 'refuted');
  assert.equal(defeated.result.packet.user_statements[0].defeated, true);
});

test('validity strings are normalized by the host; unreadable ones become a host question', async () => {
  const dated = await runtime().run(prop('s1', 'stated', {valid: ['from "2025"', 'until "2026"']}) + '@q query\n' + match('"Maria"', '"Alpha Lab"') + '  at "June 2025"\n', {origin: 'model'});
  assert.equal(dated.result.packet.status, 'supported');
  assert.match(dated.executionSop, /valid 2025-01-01T00:00:00\.000Z 2026-01-01T00:00:00\.000Z/);
  assert.match(dated.executionSop, /at 2025-06-01T00:00:00\.000Z/);
  const outside = await runtime().run(prop('s1', 'stated', {valid: ['from "2025"', 'until "2026"']}) + '@q query\n' + match('"Maria"', '"Alpha Lab"') + '  at "2026-03-01"\n', {origin: 'model'});
  assert.equal(outside.result.packet.status, 'unknown');
  const vague = await runtime().run(prop('s1', 'stated', {valid: ['from "last spring"']}) + question, {origin: 'model'});
  assert.equal(vague.result.packet.status, 'clarify');
  assert.equal(vague.result.packet.reason, 'unresolved_link');
  assert.equal(vague.result.text, 'Which date or period do you mean by "last spring"?');
});

test('unlinked or ambiguous strings stop at a host clarification; nothing is guessed', async () => {
  const unknown = await runtime().run(prop('s1', 'stated', {relation: '"flies to"'}) + question, {origin: 'model'});
  assert.deepEqual([unknown.result.packet.status, unknown.result.packet.reason, unknown.result.packet.required[0].status], ['clarify', 'unresolved_link', 'unknown']);
  assert.match(unknown.result.text, /I do not know the relation "flies to"/);
  assert.match(unknown.executionSop, /@hostClarify clarify/);
  const twin = new Lexicon('@runs_company predicate\n  role subject person\n  role object organization\n  label en "runs"\n@runs_team predicate\n  role subject person\n  role object organization\n  label en "runs"\n@maria entity\n  kind person\n  label en "Maria"');
  const ambiguous = await new Runtime({lexicon: twin, schema: twin.predicates, now: NOW}).run('@q query\n' + match('"Maria"', '?what', 'affirmed', '"runs"'), {origin: 'model'});
  assert.equal(ambiguous.result.packet.status, 'clarify');
  assert.deepEqual(ambiguous.result.packet.required[0].candidates.map(c => c.id), ['runs_company', 'runs_team']);
  const homonyms = new Lexicon('@works_at predicate\n  role subject person\n  role object organization\n  label en "works at"\n@maria_one entity\n  kind person\n  alias en "Maria"\n@maria_two entity\n  kind person\n  alias en "Maria"\n@acme entity\n  kind organization\n  label en "Acme"');
  const identity = await new Runtime({lexicon: homonyms, schema: homonyms.predicates, now: NOW}).run('@q query\n' + match('"Maria"', '"Acme"'), {origin: 'model'});
  assert.equal(identity.result.packet.status, 'clarify');
  assert.deepEqual(identity.result.packet.required[0].candidates.map(c => c.id), ['maria_one', 'maria_two']);
});

test('model assumptions: report by default, branch only on host policy, primary answer assumption-free', async () => {
  const reported = await runtime().run(prop('a1', 'assumed', {extra: []}) + question, {origin: 'model'});
  assert.equal(reported.result.packet.status, 'unknown');
  assert.equal(reported.result.packet.assumption_policy, 'report');
  assert.doesNotMatch(reported.executionSop, /@a1 fact/);
  const [a] = reported.result.packet.model_assumptions;
  assert.deepEqual([a.treatment, a.basis, a.predicate, a.used_in_proof, a.defeated], ['reported', 'unspecified', 'works_at', null, null]);
  assert.match(a.statement, /^The model assumed: works at/);
  assert.equal(reported.result.packet.assumption_branch, undefined);
  // In report mode an unlinkable assumption is reported, never blocking the turn.
  const loose = await runtime().run(prop('a1', 'assumed', {relation: '"flies to"'}) + question, {origin: 'model'});
  assert.equal(loose.result.packet.status, 'unknown');
  assert.equal(loose.result.packet.model_assumptions[0].predicate, null);
  const branched = await runtime({modelAssumptions: 'branch'}).run(prop('a1', 'assumed', {extra: ['basis world']}) + question, {origin: 'model'});
  assert.equal(branched.result.packet.status, 'unknown', 'the primary answer ignores assumptions');
  assert.equal(branched.result.packet.hypothetical, false);
  assert.deepEqual(branched.result.packet.assumption_branch.map(b => [b.status, b.hypothetical]), [['supported', true]]);
  assert.deepEqual([branched.result.packet.model_assumptions[0].treatment, branched.result.packet.model_assumptions[0].used_in_proof], ['branched', true]);
  assert.match(branched.executionSop, /@a1 fact\n  holds works_at \$\w+ \$\w+\n  valid timeless\n  source assumption/);
  assert.match(branched.result.text, /Only under the model's assumptions: /);
  const other = await runtime({modelAssumptions: 'branch'}).run(prop('a1', 'assumed', {extra: ['basis closure']}) + question, {origin: 'model'});
  assert.equal(other.result.packet.assumption_branch[0].status, 'supported', 'basis never changes admission or results');
  const contrary = await runtime({modelAssumptions: 'branch'}).run(prop('s1', 'stated', {polarity: 'negated'}) + prop('a1', 'assumed') + question, {origin: 'model'});
  assert.equal(contrary.result.packet.status, 'refuted');
  assert.equal(contrary.result.packet.model_assumptions[0].defeated, true);
});

test('lifecycle: asserted statements are carried in caller context; assumptions and suppositions are not', async () => {
  const conversation = {};
  const engine = runtime({modelAssumptions: 'branch'});
  const first = await engine.run(prop('s1', 'stated') + prop('s2', 'stated', {roles: [['subject', '"Ana"'], ['object', '"Alpha Lab"']], extra: ['certainty supposed']}) + prop('a1', 'assumed', {roles: [['subject', '"Carina"'], ['object', '"Alpha Lab"']]}), {origin: 'model', inputText: 'Maria works at Alpha Lab.', context: conversation});
  assert.equal(first.result.packet.status, 'context_updated');
  assert.match(first.result.text, /apply only to a question in the same message/);
  assert.deepEqual(conversation.statements.map(s => [s.origin, s.text]), [['user-statement', 'Maria works at Alpha Lab.']]);
  const next = await engine.run(question, {origin: 'model', context: conversation});
  assert.equal(next.result.packet.status, 'supported');
  assert.equal(next.result.packet.hypothetical, false);
  for (const who of ['"Ana"', '"Carina"']) {
    const probe = await engine.run('@q query\n' + match(who, '"Alpha Lab"'), {origin: 'model', context: conversation});
    assert.equal(probe.result.packet.status, 'unknown', who);
  }
  await assert.rejects(runtime().run(prop('s1', 'stated') + question, {origin: 'model', context: {statements: [{atom: {p: 'x', a: ['y']}}]}}), /Only attributed user statements are carried across turns/);
});

test('unclear: the kinds a context-free model can recognise, replies from one table', async () => {
  assert.deepEqual(Object.keys(UNCLEAR_KINDS), ['gibberish', 'no_request', 'ambiguous', 'relation_not_in_memory']);
  for (const kind of ['gibberish', 'no_request']) {
    const out = await runtime().run(`@u unclear\n  kind ${kind}`, {origin: 'model'});
    assert.equal(out.result.packet.status, 'unclear');
    await assertReply(out.result.text, kind);
    assert.equal(out.executionSop, '');
  }
  assert.ok(UNCLEAR_KINDS.gibberish);
  // The reply is English whatever language was selected: another language is the translation at the output edge.
  assert.equal((await runtime().run('@u unclear\n  kind gibberish', {origin: 'model', language: 'ro', languageSource: 'request'})).result.text, (await runtime().run('@u unclear\n  kind gibberish', {origin: 'model'})).result.text);
  assert.equal((await runtime().run('@u unclear\n  kind gibberish', {origin: 'model', language: 'ro', languageSource: 'request'})).result.language, 'en');
  assert.equal((await runtime().run('@u unclear\n  kind gibberish\n  language en', {origin: 'model'})).result.language, 'en');
  assert.throws(() => parse('@u unclear\n  kind gibberish\n  language ro'), /unclear language must be one of en/);
  for (const type of ['stated', 'assumed']) await assert.rejects(runtime().run(prop('s', type)), /model-surface declaration/);
  await assert.rejects(runtime().run('@u unclear\n  kind gibberish'), /model-surface declaration/);
});

test('no model refusal: an understood problem without an engine is stated as such', async () => {
  const out = await runtime().run('@c constraint\n  var ?x int\n  require ?x at_least 3\n  claim ?x at_least 1\n  task prove', {origin: 'model'});
  assert.equal(out.result.packet.status, 'not_computable');
  assert.equal(out.result.packet.engine_status, 'unsupported');
  assert.match(out.result.text, /^I understood the question as: @c constraint; var \?x int; .* I cannot compute this kind of answer yet\.$/);
  const trusted = await runtime().run('@c constraint\n  var ?x int\n  require ?x >= 3\n  claim ?x >= 1\n@r solve\n  constraint $c');
  assert.equal(trusted.result.status, 'unsupported', 'trusted circuits keep AGENTS rule 8');
});
