// Generic fixes found on the commonsense-v1 author rows (eval-commonsense-v1, Qwen3.8 27b): none is about a missing fact.
//   1. a role the memory types as free text (used_for: the activity) holds its string as written, never an entity to resolve;
//   2. quantities with units in a comparison ("1 hour" above "3000 seconds") are lowered onto the memory's unit facts (sop/quantities.mjs);
//   3. where the role expects a class (the object of is_a), a class whose label is the surface leads one that has it only as an alias;
//   4. a rule over two named entities keys every atom of its body on one of them, through rule calls as well (reasoning/slice/demand.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {chooseEntity} from '../../sop/knowledge-linker.mjs';
import {lowerQuantities, readQuantity, predicateWithReading, quantityBound} from '../../sop/quantities.mjs';
import {Demand} from '../../reasoning/slice/demand.mjs';
import {context} from '../helpers.mjs';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const predicate = (id, roles, ...extra) => `@${id} predicate\n${roles.map(r => '  role ' + r).join('\n')}\n${extra.map(e => '  ' + e + '\n').join('')}`;
const entity = (id, label, ...more) => `@${id} entity\n  label en ${JSON.stringify(label)}\n${more.map(m => '  ' + m + '\n').join('')}`;
const VOCABULARY = [
  predicate('is_a', ['subject entity', 'object entity'], 'label en "is a"', 'reading class'),
  predicate('used_for', ['subject entity', 'object text'], 'label en "used for"'),
  predicate('base_amount', ['subject unit', 'object integer'], 'label en "amount in base units"', 'reading unit_amount'),
  predicate('dimension_of', ['subject unit', 'object entity'], 'label en "dimension of"', 'reading unit_dimension'),
];
const ENTITIES = [
  entity('class', 'class', 'kind class'), entity('unit', 'unit', 'kind class'),
  entity('knife', 'knife', 'kind class'), entity('hammer', 'hammer', 'kind class'),
  entity('tool_class', 'tool', 'kind class'), entity('device', 'device', 'kind class', 'alias en "tool"'),
  entity('hour', 'hour', 'kind unit', 'alias en "hours"'), entity('second', 'second', 'kind unit', 'alias en "seconds"'),
  entity('kilogram', 'kilogram', 'kind unit', 'alias en "kg"'), entity('gram', 'gram', 'kind unit', 'alias en "grams"'),
  entity('metre', 'metre', 'kind unit', 'alias en "metres"'),
  entity('duration', 'duration'), entity('mass', 'mass'), entity('length', 'length'),
];
const fact = (n, atom) => `@f${n} fact\n  holds ${atom}\n  valid timeless\n  source demo\n`;
const FACTS = ['used_for knife "cutting"', 'is_a hammer tool_class',
  'base_amount hour 3600000', 'base_amount second 1000', 'base_amount kilogram 1000000', 'base_amount gram 1000', 'base_amount metre 1000000',
  'dimension_of hour duration', 'dimension_of second duration', 'dimension_of kilogram mass', 'dimension_of gram mass', 'dimension_of metre length',
].map((atom, i) => fact(i, atom)).join('');
// The lexicon of a base memory is compiled from all its circuits, facts included (the unit facts are indexed for quantities).
const LEXICON = new Lexicon([...VOCABULARY, ...ENTITIES, FACTS].join('\n'));

async function withKnowledge(body) {
  const c = context({bootstrap: false});
  try {
    publishKnowledge(c.repo, 'base', FACTS, {schema: LEXICON.predicates, reviewed: true, knownAt: Date.parse('2024-01-01')});
    const run = source => new Runtime({repo: c.repo, session: c.repo.session('base', 'alice', 's' + Math.random().toString(36).slice(2)), lexicon: LEXICON, schema: LEXICON.predicates, now: NOW}).run(source, {origin: 'model'});
    await body(run);
  } finally { c.dispose(); }
}
const status = r => r.result.packet.status;
const ask = (relation, roles) => `@q query\n  where match\n    relation ${JSON.stringify(relation)}\n${roles.map(([n, v]) => `    role ${n} ${JSON.stringify(v)}\n`).join('')}    polarity affirmed\n  end\n`;
const compare = line => `@q query\n  compare ${line}\n`;

test('a text-typed role keeps its string: "Is a knife used for cutting?" is answered, not asked about an entity "cutting"', async () => {
  await withKnowledge(async run => {
    const r = await run(ask('used for', [['subject', 'knife'], ['object', 'cutting']]));
    assert.equal(status(r), 'supported', r.result.text);
    assert.notEqual(r.result.packet.reason, 'unresolved_dependency');
  });
});

test('quantities: a number with a unit the memory knows is read through its lexicon, never a leading number alone', () => {
  assert.deepEqual(readQuantity('"3000 seconds"', LEXICON), {amount: '3000', unit: 'second', surface: '3000 seconds', unitSurface: 'seconds', match: 'exact'});
  assert.equal(readQuantity('"2380 lei"', LEXICON), null, 'a unit the memory does not know stays a written value');
  assert.equal(readQuantity('"hour"', LEXICON), null, 'no number, no quantity');
  assert.equal(predicateWithReading(LEXICON, 'unit_amount'), 'base_amount');
  let n = 0;
  const lowered = lowerQuantities(['"1 hour" above "3000 seconds"', '?x above 3'], LEXICON, {fresh: () => `?v${n++}`});
  assert.deepEqual(lowered.compare, ['?v0 above 3000000', '?x above 3'], '1 x ?hour > 3000 x 1000 base units');
  assert.deepEqual(lowered.where, ['base_amount hour ?v0', 'base_amount second ?v1', 'dimension_of hour ?v2', 'dimension_of second ?v2']);
  // exact bounds on the integer amount: 1.5 x ?a > 5000 x 1000 is ?a > 3333333.33..., i.e. ?a above 3333333; equality with a non-integer never holds
  assert.deepEqual(quantityBound('above', '1.5', '5000', '1000'), {op: 'above', value: '3333333'});
  assert.deepEqual(quantityBound('at_least', '1.5', '5000', '1000'), {op: 'at_least', value: '3333334'});
  assert.deepEqual(quantityBound('below', '1.5', '5000', '1000'), {op: 'below', value: '3333334'});
  assert.deepEqual(quantityBound('equal', '1.5', '5000', '1000'), {op: 'equal', value: '"3333333.5"'});
  assert.deepEqual(quantityBound('equal', '2', '7200', '1000'), {op: 'equal', value: '3600000'});
  const none = lowerQuantities(['"1 hour" above "3000 seconds"'], new Lexicon(ENTITIES.join('\n')), {fresh: () => '?z'});
  assert.deepEqual(none, {compare: ['"1 hour" above "3000 seconds"'], where: [], quantities: []}, 'without the declared unit predicates nothing is lowered');
});

test('quantities: comparisons of measures convert through the unit facts of the memory', async () => {
  await withKnowledge(async run => {
    assert.equal(status(await run(compare('"1 hour" above "3000 seconds"'))), 'supported');
    assert.equal(status(await run(compare('"1 kilogram" above "900 grams"'))), 'supported', 'not 1 > 900 by leading numbers');
    assert.equal(status(await run(compare('"1 kg" below "900 grams"'))), 'refuted');
    const mixed = await run(compare('"1 hour" above "3 metres"'));
    assert.notEqual(status(mixed), 'supported', 'units of different dimensions are never compared');
    assert.notEqual(status(mixed), 'refuted');
  });
});

test('KnowledgeLinker: where the role expects a class, the class labelled with the surface leads the class that has it only as an alias', async () => {
  const found = LEXICON.matching('tool', {language: 'auto', kind: 'entity'}).found;
  assert.deepEqual(found.map(e => e.id).sort(), ['device', 'tool_class']);
  const chosen = chooseEntity(LEXICON, found, {type: 'class', surface: 'tool'});
  assert.equal(chosen.chosen?.id, 'tool_class');
  assert.equal(chosen.by, 'form_tier');
  assert.equal(chooseEntity(LEXICON, found, {type: 'entity', surface: 'tool'}).chosen, null, 'an untyped role still asks');
  await withKnowledge(async run => {
    const r = await run(ask('is a', [['subject', 'hammer'], ['object', 'tool']]));
    assert.equal(status(r), 'supported', r.result.text);
  });
});

test('demand: a rule over two named entities keys its body on both, also through a rule it calls', () => {
  const atom = (p, ...a) => ({p, a, neg: false});
  const rules = [
    {id: 'contemporary', if: [atom('born', '?a', '?x'), atom('born', '?b', '?y'), atom('died', '?a', '?u'), atom('died', '?b', '?v')], then: atom('contemporary_of', '?a', '?b')},
    {id: 'not_contemporary', if: [atom('lived_before', '?a', '?b')], then: {...atom('contemporary_of', '?a', '?b'), neg: true}},
    {id: 'lived_before', if: [atom('died', '?a', '?d'), atom('born', '?b', '?x')], then: atom('lived_before', '?a', '?b')},
  ];
  const d = new Demand({conjunctions: [[atom('contemporary_of', 'mozart', 'beethoven')]], rules});
  assert.deepEqual(d.scans(), [], 'no predicate is scanned for the second person');
  const owed = d.obligations().map(o => `${o.p}#${o.i}=${o.value}`).sort();
  for (const key of ['born#0=mozart', 'born#0=beethoven', 'died#0=mozart', 'died#0=beethoven']) assert.ok(owed.includes(key), key);
});
