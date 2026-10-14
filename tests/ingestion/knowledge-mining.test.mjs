import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parse} from '../../sop/knowledge/index.mjs';
import {canonicalKey, memoryIndex, againstMemory, problemNames, problemOverlap, booksGramIndex, copyFindings, provenance, stamp, uniqueIds, mergeKnownEntities} from '../../tools/knowledge-mining/checks.mjs';
import {failureText, LAYER_DIR} from '../../tools/knowledge-mining/mine.mjs';
import {validateCircuits} from '../../lib/chat-data/memories.mjs';
import {seedLayers, seedInfo} from '../../lib/knowledge-seeds.mjs';

const wire = text => parse(text).wires[0];
const MEMORY = [{name: 'm.sop', text: `@u_week entity
  kind unit
  label en "week"

@f1 fact
  holds converts_to week day 7
  source "x"

@f2 fact
  holds not capable_of fish "fly"
  source "x"

@r1 rule
  when base_amount ?a ?x
  then same_dimension ?a ?a
  source "x"
`}];

test('canonical keys ignore ids, metadata and variable names', () => {
  const a = wire('@a rule\n  when base_amount ?u ?n\n  then same_dimension ?u ?u\n  source "one"\n');
  const b = wire('@b rule\n  when base_amount ?k ?m\n  then same_dimension ?k ?k\n  source "two"\n');
  assert.equal(canonicalKey(a), canonicalKey(b));
});

test('duplicates and contradictions are found against the memory', () => {
  const index = memoryIndex(MEMORY);
  assert.equal(againstMemory(wire('@x fact\n  holds converts_to week day 7\n  source "y"\n'), index).duplicate, true);
  assert.match(againstMemory(wire('@x fact\n  holds converts_to week day 8\n  source "y"\n'), index).conflicts[0], /7/);
  assert.equal(againstMemory(wire('@x fact\n  holds capable_of fish "fly"\n  source "y"\n'), index).conflicts.length, 1);
  assert.equal(againstMemory(wire('@x fact\n  holds converts_to day hour 24\n  source "y"\n'), index).conflicts.length, 0);
  assert.equal(againstMemory(wire('@y rule\n  when base_amount ?q ?z\n  then same_dimension ?q ?q\n  source "z"\n'), index).duplicate, true);
});

test('the problem\'s own names and numbers are detected in a candidate, general labels are not names', () => {
  const index = memoryIndex(MEMORY);
  const names = problemNames('Mara walks 3 km each Week. Then Mara rests.', index.labels);
  assert.deepEqual(names, ['Mara']); // "Week" is a general label, not a name
  const names2 = problemNames('Each day, Mara walks 3 km with Daria.', index.labels);
  assert.deepEqual(names2, ['Mara', 'Daria']);
  const w = wire('@kmb_x fact\n  holds converts_to week day 7\n  source "Mara"\n');
  assert.deepEqual(problemOverlap(w, {names: names2, numbers: [3, 7]}), {names: [], numbers: [7]});
  assert.deepEqual(problemOverlap(wire('@kmb_y fact\n  holds capable_of mara "walk"\n  source "x"\n'), {names: names2, numbers: []}).names, ['Mara']);
});

test('copied book text is caught by long spans and distinctive shared 4-grams', () => {
  const items = [{question: 'The red lantern of the old harbour keeper shines across the bay every night', answer: 'yes'}, {question: 'unrelated text about apples', answer: 'no'}];
  const books = booksGramIndex(items);
  const copied = wire('@kmb_c fact\n  holds typical_property lantern "the red lantern of the old harbour keeper shines"\n  source "x"\n');
  assert.equal(copyFindings(copied, items[0].question, books).copied, true);
  const clean = wire('@kmb_d fact\n  holds typical_property lantern "bright"\n  source "x"\n');
  assert.equal(copyFindings(clean, items[0].question, books).copied, false);
});

test('provenance replaces the source of a wire; a predicate gets a comment line', () => {
  const prov = provenance({book: 'math', problem: 'math:1.1', model: 'M', reviewer: 'R', date: '2026-10-02'});
  assert.match(stamp(wire('@kmb_f fact\n  holds converts_to day hour 24\n  source "general knowledge"\n'), prov), /source "mined for commonsense-books-v1 .*problem math:1.1, proposed by M, reviewed by R, 2026-10-02/);
  assert.match(stamp(wire('@kmb_p predicate\n  args subject:entity\n  role subject entity\n  label en "p"\n'), prov), /^# provenance @kmb_p: /);
});

test('knowledge ids get the problem prefix; a known entity is merged into the memory one', () => {
  const index = memoryIndex(MEMORY);
  const wires = parse('@kmb_week entity\n  kind unit\n  label en "week"\n  source "x"\n\n@kmb_f fact\n  holds converts_to kmb_week day 7\n  source "x"\n').wires;
  const merged = mergeKnownEntities(wires, index.labels);
  assert.deepEqual(merged.merged, [['kmb_week', 'u_week']]);
  assert.equal(merged.wires.length, 1);
  assert.match(merged.wires[0].fields[0].value, /^converts_to u_week day 7$/);
  assert.equal(uniqueIds(merged.wires, 'kmb_math_1_1')[0].id, 'kmb_math_1_1_f');
});

test('the failure trace never carries the gold answer', () => {
  const text = failureText({ok: true, text: 'reply', sop: '@q query', gold: 'GOLD-SECRET', system: {status: 'unclear', unclear_kind: 'relation_not_in_memory'}});
  assert.doesNotMatch(text, /GOLD-SECRET/);
  assert.match(text, /relation_not_in_memory/);
});

test('the commonsense-books-v1 layer validates over its imports', () => {
  const info = seedInfo('commonsense-books-v1');
  assert.deepEqual(info.imports, ['core-min', 'core-en', 'commonsense-v1']);
  const own = fs.readdirSync(LAYER_DIR).filter(n => n.endsWith('.sop')).map(n => ({name: n, text: fs.readFileSync(`${LAYER_DIR}/${n}`, 'utf8')}));
  const lower = info.imports.flatMap(id => seedLayers(id)).filter((c, i, a) => a.findIndex(x => x.name === c.name) === i);
  const check = validateCircuits(own, lower);
  assert.equal(check.ok, true, JSON.stringify(check.problems.slice(0, 3)));
});

test('a fact about an undeclared constant is a story entity; unused declarations are pruned', async () => {
  const {undeclaredConstants, pruneDeclarations} = await import('../../tools/knowledge-mining/checks.mjs');
  const ids = new Set(['week', 'day', 'converts_to']);
  assert.deepEqual(undeclaredConstants(wire('@f fact\n  holds converts_to week day 7\n  source "x"\n'), ids), []);
  assert.deepEqual(undeclaredConstants(wire('@f fact\n  holds converts_to kmb_damp_wall day "x"\n  source "x"\n'), ids), ['kmb_damp_wall']);
  const wires = parse('@p_used predicate\n  args subject:entity\n  role subject entity\n  label en "u"\n\n@p_unused predicate\n  args subject:entity\n  role subject entity\n  label en "v"\n\n@f fact\n  holds p_used week\n  source "x"\n').wires;
  assert.deepEqual(pruneDeclarations(wires).map(w => w.id), ['p_used', 'f']);
});
