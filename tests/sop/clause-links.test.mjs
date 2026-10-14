// DS014 "Clauses and links", "Content words" and "Honest partial formalization": clause link keyword lines,
// `$id` role values and query chaining, the host plan of links, content words in the message's language translated
// by the host dictionary, and `unparsed` spans with symbolic repair (owner decisions D1 and L1-L4 of 2026-09-29).
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, canonical, linksOf, roleReferences, SPEC} from '../../sop/parser.mjs';
import {LINK_KEYWORDS, LINK_WORDS, LINK_TYPES, UNPARSED_HINTS} from '../../sop/enums.mjs';
import {compileDeclarative, checkModelProgram, MODEL_TYPES} from '../../sop/declarative.mjs';
import {planLinks, expandReferences, pairPlaceholders} from '../../sop/clauses.mjs';
import {repairSpan, parseQuantity, spanQuestion} from '../../sop/repair.mjs';
import {Dictionary} from '../../sop/dictionary.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {Agent} from '../../server/agent.mjs';
import {mentionedThroughDictionary} from '../../sop/linking.mjs';
import {context, lex, schema} from '../helpers.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const wire = (id, type, ...lines) => `@${id} ${type}\n` + lines.map(line => '  ' + line).join('\n') + '\n';
const stated = (id, relation, subject, object, ...extra) => wire(id, 'stated', `relation ${JSON.stringify(relation)}`, `role subject ${subject}`, ...(object ? [`role object ${object}`] : []), 'polarity affirmed', ...(extra.some(line => line.startsWith('certainty')) ? [] : ['certainty asserted']), ...extra);
const query = (id, relation, subject, object, ...extra) => `@${id} query\n  where match\n    relation ${JSON.stringify(relation)}\n    role subject ${subject}\n    role object ${object}\n    polarity affirmed\n  end\n` + extra.map(line => '  ' + line + '\n').join('');
const compile = (source, options = {}) => compileDeclarative(source, {lexicon: lex, schema, now: NOW, ...options});
async function run(source, {inputText = '', ctx = {statements: []}, policy = {}, language = 'en'} = {}) {
  const c = context();
  try {
    const result = await new Runtime({repo: c.repo, session: c.session, lexicon: lex, schema, now: NOW, policy}).run(source, {origin: 'model', inputText, language, context: ctx});
    return result.result;
  } finally { c.dispose(); }
}

test('the link keywords are one closed, exported table mapped to semantic types', () => {
  assert.deepEqual(LINK_WORDS, ['because', 'so', 'if', 'unless', 'although', 'so_that', 'before', 'after', 'when', 'while']);
  assert.deepEqual(Object.fromEntries(LINK_WORDS.map(k => [k, LINK_KEYWORDS[k].type])), {because: 'cause', so: 'cause', if: 'condition', unless: 'negative_condition', although: 'concession', so_that: 'purpose', before: 'before', after: 'after', when: 'during', while: 'during'});
  assert.deepEqual(LINK_TYPES, ['cause', 'condition', 'negative_condition', 'concession', 'purpose', 'before', 'after', 'during']);
  for (const type of ['stated', 'assumed', 'query']) for (const keyword of LINK_WORDS) assert.ok(SPEC[type].many.includes(keyword), `${type}.${keyword}`);
  assert.ok(!SPEC.constraint.many?.includes('because'), 'a constraint carries no link');
  assert.deepEqual(UNPARSED_HINTS, ['subject', 'object', 'time', 'location', 'value', 'relation', 'reference', 'other']);
  assert.ok(MODEL_TYPES.has('unparsed'));
});

test('parser: a link line takes exactly one $id; at most three per wire; one $id role value per wire', () => {
  const base = stated('s1', 'works at', '"Ana"', '"Beta Lab"');
  const program = parse(base.trimEnd() + '\n  because $s2\n' + stated('s2', 'works at', '"Carina"', '"Beta Lab"'));
  assert.deepEqual(linksOf(program.wires[0]), [{keyword: 'because', target: 's2'}]);
  assert.equal(canonical(program).includes('  because $s2\n'), true);
  assert.throws(() => parse(base + '  because s2\n'), /link_form/);
  assert.throws(() => parse(base + '  because $s2 $s3\n'), /link_form/);
  assert.throws(() => parse(base + '  because "$s2"\n'), /link_form/);
  assert.throws(() => parse(base + '  because $a\n  after $b\n  when $c\n  although $d\n'), /link_too_many/);
  assert.throws(() => parse(base + '  because $a\n  because $a\n'), /link_duplicate/);
  assert.throws(() => parse(base + '  therefore $a\n'), /Unsupported field therefore on stated/);
  assert.throws(() => parse(stated('s1', 'be fair', '$s2', '$s3')), /reference_multiple/);
  assert.throws(() => parse(stated('s1', 'be fair', '"$s2"', null)), /proposition_not_ground/);
  assert.deepEqual(roleReferences(parse(stated('s1', 'be fair', '$s2', null)).wires[0]), [{role: 'subject', target: 's2'}]);
});

test('admission: links and references name the right wires, without cycles or conflicts', () => {
  const s2 = stated('s2', 'works at', '"Carina"', '"Beta Lab"');
  const supposed = stated('s2', 'works at', '"Carina"', '"Beta Lab"', 'certainty supposed');
  const q = query('q', 'works at', '"Ana"', '"Beta Lab"');
  const cases = [
    [stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'because $s9') + s2, /link_reference_unknown/],
    [stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'because $s1'), /link_self_reference/],
    [q + stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'because $q'), /link_target_type/],
    [q.trimEnd() + '\n  if $s2\n' + s2, /link_condition_not_supposed/],
    [q.trimEnd() + '\n  so_that $s2\n' + s2, /link_condition_not_supposed/],
    [q.trimEnd() + '\n  if $s2\n' + query('q2', 'works at', '"Ana"', '"Beta Lab"', 'unless $s2') + supposed, /link_conflict/],
    [stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'because $s2') + stated('s2', 'works at', '"Carina"', '"Beta Lab"', 'after $s1'), /link_cycle/],
    [stated('s1', 'be fair', '$q', null) + q, /reference_target_type/],
    [query('q2', 'works at', '$q', '?x', 'select ?x') + q, /reference_query_not_single/],
    [stated('s1', 'works at', '"Ana"', '?x'), /proposition_not_ground/],
  ];
  for (const [source, error] of cases) assert.throws(() => checkModelProgram(parse(source)), error, source);
  assert.doesNotThrow(() => checkModelProgram(parse(q.trimEnd() + '\n  if $s2\n' + supposed)));
  // A forward reference is legal: links are resolved by name, not by order.
  assert.doesNotThrow(() => checkModelProgram(parse(stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'after $s2') + s2)));
});

test('host plan: a condition scopes its query, a timed temporal link bounds the period, the rest is not_checked', () => {
  const program = parse(stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'certainty supposed')
    + stated('s2', 'works at', '"Carina"', '"Beta Lab"', 'valid on "2023"')
    + query('q', 'works at', '"Maria"', '"Alpha Lab"', 'if $s1', 'after $s2', 'because $s2')
    + query('q2', 'works at', '"Maria"', '"Alpha Lab"', 'before $s1'));
  const plan = planLinks(program.wires, {now: NOW});
  assert.deepEqual(plan.conditions.get('q'), ['s1']);
  assert.deepEqual([...plan.scoped], ['s1']);
  assert.deepEqual(plan.periods.get('q'), {from: Date.UTC(2023, 0, 1), until: Infinity});
  assert.deepEqual(plan.links.map(l => [l.from, l.keyword, l.status, l.effect ?? l.reason]), [
    ['q', 'because', 'not_checked', 'no_engine'], ['q', 'if', 'applied', 'condition_scoped'], ['q', 'after', 'applied', 'from'], ['q2', 'before', 'not_checked', 'untimed']]);
});

test('execution: if scopes the supposition to its own query; unless supposes the negated clause', async () => {
  const s1 = stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'certainty supposed');
  const both = s1 + query('q', 'works at', '"Ana"', '"Beta Lab"', 'if $s1') + query('q2', 'works at', '"Ana"', '"Beta Lab"');
  const result = await run(both);
  assert.match(result.text, /q:\nThis result depends on the stated assumptions[\s\S]*q2:\nThe available information does not decide/);
  assert.deepEqual(result.packet.clause_links, [{from: 'q', keyword: 'if', type: 'condition', to: 's1', status: 'applied', effect: 'condition_scoped'}]);
  // Without a link, a supposition still conditions every question of the message.
  const flat = await run(s1 + query('q', 'works at', '"Ana"', '"Beta Lab"') + query('q2', 'works at', '"Ana"', '"Beta Lab"'));
  assert.equal((flat.text.match(/depends on the stated assumptions/g) ?? []).length, 2);
  const unless = await run(stated('s1', 'works at', '"Maria"', '"Beta Lab"', 'certainty supposed') + query('q', 'works at', '"Maria"', '"Beta Lab"', 'unless $s1'));
  assert.equal(unless.packet.status, 'refuted');
  assert.equal(unless.packet.hypothetical, true);
});

test('execution: a timed after/before link bounds the query period; an untimed or causal link is reported', async () => {
  const s2 = stated('s2', 'works at', '"Carina"', '"Beta Lab"', 'valid on "2023"');
  const before = await run(s2 + query('q', 'works at', '"Maria"', '"Alpha Lab"', 'before $s2'));
  assert.equal(before.packet.status, 'unknown', 'Maria works at Alpha Lab only from 2024');
  const after = await run(s2 + query('q', 'works at', '"Maria"', '"Alpha Lab"', 'after $s2'));
  assert.equal(after.packet.status, 'supported');
  const causal = await run(stated('s2', 'works at', '"Carina"', '"Beta Lab"') + query('q', 'works at', '"Maria"', '"Alpha Lab"', 'because $s2'));
  assert.equal(causal.packet.status, 'supported', 'the atoms execute');
  assert.match(causal.text, /Not checked: because: works at \(subject: Carina; object: Beta Lab\)/);
  const statement = await run(stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'because $s2') + stated('s2', 'works at', '"Carina"', '"Beta Lab"'));
  const s1 = statement.packet.user_statements.find(s => s.id === 's1');
  assert.equal(s1.treatment, 'evidence');
  assert.match(s1.statement, /You stated: works at \(subject: Ana; object: Beta Lab\), because: works at \(subject: Carina; object: Beta Lab\) \[not checked\]\./);
  assert.deepEqual(s1.links, [{from: 's1', keyword: 'because', type: 'cause', to: 's2', status: 'not_checked', reason: 'statement_link'}]);
});

test('a statement that carries if/unless is conditional and never evidence', async () => {
  const result = await run(stated('s1', 'works at', '"Ana"', '"Beta Lab"', 'if $s2') + stated('s2', 'works at', '"Carina"', '"Beta Lab"', 'certainty supposed') + query('q', 'works at', '"Ana"', '"Beta Lab"'));
  const s1 = result.packet.user_statements.find(s => s.id === 's1');
  assert.equal(s1.treatment, 'conditional_statement');
  assert.equal(s1.in_circuit, false);
  assert.equal(result.packet.status, 'unknown');
});

test('query chaining: $q is the answers of another query (a join); $s as an argument is not computable', async () => {
  const q = '@q query\n  select ?p\n  where match\n    relation "works at"\n    role subject ?p\n    role object "Alpha Lab"\n    polarity affirmed\n  end\n';
  const q2 = '@q2 query\n  select ?place\n  where match\n    relation "works at"\n    role subject $q\n    role object ?place\n    polarity affirmed\n  end\n';
  const expanded = expandReferences(parse(q + q2).wires);
  assert.equal(expanded.joins.length, 1);
  assert.equal(expanded.wires[1].fields.where.length, 2, 'q\'s condition is inlined into q2');
  const result = await run(q + q2);
  assert.match(result.text, /q2:\n[\s\S]*Answer: (?:Lab Alpha|Alpha Lab)/);
  const event = await run(stated('s2', 'works at', '"Carina"', '"Beta Lab"') + query('q', 'be fair', '$s2', '"Ana"'));
  assert.equal(event.packet.status, 'not_computable');
  assert.match(event.packet.understood_as, /\[works at\]/);
  const argument = await run(stated('s2', 'works at', '"Carina"', '"Beta Lab"') + stated('s3', 'be fair', '$s2', null) + query('q', 'works at', '"Maria"', '"Alpha Lab"'));
  assert.equal(argument.packet.status, 'supported');
  assert.equal(argument.packet.user_statements.find(s => s.id === 's3').treatment, 'reported');
});

test('a constraint may use the scalar answer of a query ($q)', () => {
  const q = '@q query\n  select ?minutes\n  where match\n    relation "duration"\n    role subject "the route"\n    role object ?minutes\n    polarity affirmed\n  end\n';
  const c = '@c constraint\n  var ?x int 0 1000\n  require ?x equal $q times 2\n  select ?x\n  task possible\n';
  const {wires} = expandReferences(parse(q + c).wires);
  assert.match(wires[1].fields.require[0], /\$minutes times 2/);
});

// A small inline dictionary keeps these tests independent of the data files (config/dictionary). English only: the core's
// dictionary view carries synonym sets and never translates (DS014 "English-only core").
const DICT = Dictionary.fromEntries([
  {id: 'rel:works_at', pos: 'relation', en: ['work at', 'toil at'], ro: [], forms: []},
  {id: 'noun:lab', pos: 'noun', en: ['Alpha Lab', 'Alfa Laboratory'], ro: [], forms: []},
]);

test('content words: English synonyms link through the dictionary; Romanian is not translated by the core', async () => {
  const synonym = query('q', 'toil at', '"Maria"', '"Alpha Lab"');
  const plan = compile(synonym, {dictionary: DICT, frames: false});
  assert.deepEqual(plan.translations, [{wire: 'q', field: 'relation', from: 'toil at', to: 'work at', source: 'synonym', predicate: 'works_at'}]);
  assert.equal(compile(query('q', 'work at', '"Maria"', '"Alpha Lab"'), {dictionary: DICT}).translations.length, 0, 'English links directly');
  // Strict (no dictionary): the synonym does not link and the host asks.
  assert.equal(compile(synonym, {dictionary: null}).issues[0].status, 'unknown');
  // Romanian never reaches the core (the edges translate); if it did, it is asked about, never translated or guessed.
  const romanian = compile(query('q', 'lucra la', '"Maria"', '"Alpha Lab"'), {dictionary: DICT});
  assert.equal(romanian.issues[0].status, 'unknown');
  assert.equal(romanian.untranslated, undefined);
  const result = await run(query('q', 'lucra la', '"Maria"', '"Alpha Lab"'));
  assert.equal(result.packet.status, 'clarify');
  assert.equal(result.packet.translations.length, 0);
});

test('anchoring: a stated value is anchored by the message words or an English synonym of them', () => {
  assert.ok(mentionedThroughDictionary('Alpha Lab', 'Maria works at the Alfa Laboratory', DICT));
  assert.ok(!mentionedThroughDictionary('Beta Lab', 'Maria works at the Alfa Laboratory', DICT));
  const agent = new Agent({lexicon: lex, config: {}});
  const message = 'Maria works at Alpha Lab, but that company is odd?';
  assert.doesNotThrow(() => agent.validateVocabulary(stated('s1', 'work at', '"Maria"', '"Alpha Lab"'), message));
  assert.doesNotThrow(() => agent.validateVocabulary(wire('u1', 'unparsed', 'span "that company"') + query('q', 'work at', '"Maria"', '"Alpha Lab"'), message));
  assert.throws(() => agent.validateVocabulary(wire('u1', 'unparsed', 'span "the company over there"') + query('q', 'work at', '"Maria"', '"Alpha Lab"'), message), /unparsed_span_not_in_message/);
  assert.throws(() => agent.validateVocabulary(stated('s1', 'work at', '"Maria"', '"Beta Lab"'), message), /stated_value_not_in_message/);
});

test('unparsed: placeholders pair by near and hint; spans are repaired or asked about one by one', async () => {
  const s1 = stated('s1', 'works at', '"Ana"', '?x');
  const u1 = wire('u1', 'unparsed', 'span "Beta Lab"', 'near $s1', 'hint object');
  const pairs = pairPlaceholders(parse(s1 + u1));
  assert.deepEqual(pairs.byUnparsed.get('u1'), {wire: 's1', role: 'object', variable: '?x'});
  assert.throws(() => checkModelProgram(parse(s1 + wire('u1', 'unparsed', 'span "Beta Lab"', 'near $s1', 'hint subject'))), /proposition_not_ground/);
  assert.throws(() => checkModelProgram(parse(s1 + u1 + wire('u2', 'unparsed', 'span "Beta Lab"'))), /unparsed_duplicate/);
  assert.throws(() => checkModelProgram(parse(wire('u1', 'unparsed', 'span "x"', 'near $u2') + wire('u2', 'unparsed', 'span "y"'))), /unparsed_near_type/);
  assert.throws(() => parse(wire('u1', 'unparsed', 'span "x"', 'hint colour')), /unparsed hint must be one of/);
  assert.throws(() => parse(wire('u1', 'unparsed', 'span x')), /unparsed_span_form/);
  const repaired = await run(s1 + u1 + query('q', 'works at', '"Ana"', '"Beta Lab"'));
  assert.equal(repaired.packet.status, 'supported');
  assert.deepEqual(repaired.packet.repairs, [{unparsed: 'u1', span: 'Beta Lab', hint: 'object', near: 's1', wire: 's1', role: 'object', method: 'lexicon_entity', value: 'Beta Lab', filled: true}]);
  // An unresolved span holds back only what needs it and asks one targeted question, in English (the output edge translates it).
  const partial = await run(stated('s1', 'works at', '"Ana"', '?x') + wire('u1', 'unparsed', 'span "that firm near the station"', 'near $s1', 'hint object') + query('q', 'works at', '"Maria"', '"Alpha Lab"'));
  assert.equal(partial.packet.status, 'supported');
  assert.match(partial.text, /Who or what do you mean by "that firm near the station"\?/);
  assert.equal(partial.packet.next, 'answer_clarification');
  assert.equal(partial.packet.unresolved_spans[0].blocking, true);
  assert.equal(partial.packet.user_statements.find(s => s.id === 's1').treatment, 'incomplete');
  const blocked = await run(query('q', 'works at', '"Ana"', '?x') + wire('u1', 'unparsed', 'span "the thing near the station"', 'near $q', 'hint object'));
  assert.equal(blocked.packet.reason, 'unresolved_span');
  assert.equal(blocked.text, 'Who or what do you mean by "the thing near the station"?');
});

test('a repaired time in a query placeholder becomes the query period', async () => {
  const q = '@q query\n  where match\n    relation "works at"\n    role subject "Maria"\n    role object "Alpha Lab"\n    role time ?t\n    polarity affirmed\n  end\n';
  const inside = await run(q + wire('u1', 'unparsed', 'span "3 March 2025"', 'near $q', 'hint time'));
  assert.equal(inside.packet.status, 'supported');
  const before = await run(q + wire('u1', 'unparsed', 'span "3 March 2020"', 'near $q', 'hint time'));
  assert.equal(before.packet.status, 'unknown', 'Maria works at Alpha Lab only from 2024');
});

test('symbolic repair: dates, numbers, money, names, the conversation and English synonyms', () => {
  assert.deepEqual(repairSpan('3 March 2025', {hint: 'time', now: NOW}), {value: '3 March 2025', method: 'time'});
  assert.equal(repairSpan('3 martie 2025', {hint: 'time', now: NOW}), null, 'Romanian dates are not read by the core');
  assert.equal(repairSpan('next blue moon', {hint: 'time', now: NOW}), null);
  assert.equal(parseQuantity('12'), 12);
  assert.equal(parseQuantity('twelve'), 12);
  assert.equal(parseQuantity('1.140 euro'), '1140 EUR');
  assert.equal(parseQuantity('2380 lei'), '2380 RON');
  assert.equal(parseQuantity('12,5 km'), '12.5 km');
  assert.equal(parseQuantity('blah'), null);
  assert.deepEqual(repairSpan('Mihai Viteazu', {}), {value: 'Mihai Viteazu', method: 'proper_name'});
  assert.deepEqual(repairSpan('Alpha Lab', {lexicon: lex}), {value: 'Alpha Lab', method: 'lexicon_entity'});
  const lastQuery = query('q', 'works at', '"Maria"', '?x');
  assert.deepEqual(repairSpan('that one', {hint: 'reference', context: {lastQuery: query('q', 'works at', '"Maria"', '"Alpha Lab"')}}), null, 'two referents: ask');
  assert.deepEqual(repairSpan('him', {hint: 'reference', context: {lastQuery}}), {value: 'Maria', method: 'conversation'});
  assert.deepEqual(repairSpan('alfa laboratory', {dictionary: DICT}), {value: 'Alpha Lab', method: 'dictionary'});
  assert.equal(spanQuestion('that one', 'reference'), 'What does "that one" refer to?');
});
