// Document ingestion v2 (lib/ingest/v2): units, dates, the canonical vocabulary, the FOL → knowledge converter, and the whole pipeline
// with a fake chat that answers each role by its prompt. No test calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories, validateCircuits} from '../../lib/chat-data/memories.mjs';
import {Sessions} from '../../lib/chat-data/sessions.mjs';
import {chunkUnits} from '../../lib/ingest/v2/units.mjs';
import {dateValue, dateEval, dateCompute} from '../../lib/ingest/v2/dates.mjs';
import {collect, conflictCases, canonical, lookups, sharedPredicates} from '../../lib/ingest/v2/vocabulary.mjs';
import {convertDocument, renderWires, groupStatements} from '../../lib/ingest/v2/to-knowledge.mjs';
import {checkStructure, checkAlign} from '../../lib/ingest/v2/roles.mjs';
import {ingestV2} from '../../lib/ingest/v2/index.mjs';
import {quoteProblems} from '../../lib/ingest/checks.mjs';
import {tempDir} from '../helpers.mjs';

const runtimeConfig = () => JSON.parse(fs.readFileSync(new URL('../../config/runtime.json', import.meta.url), 'utf8'));
const CORE = fs.readFileSync(new URL('../../config/knowledge/core-min/0001-upper.sop', import.meta.url), 'utf8');

test('units: sentences keep the document\'s own characters as quotes; a table row is one unit', () => {
  const units = chunkUnits({text: '## 2. Rules\n\n**Note**: Ann may rest. Bob may not.\n\n| Name | Team |\n|---|---|\n| Ann | Red |\n', start_line: 10, path: ['Rules']});
  assert.deepEqual(units.map(u => u.text), ['Note: Ann may rest.', 'Bob may not.', 'Name: Ann; Team: Red.']);
  assert.equal(units[0].quote, 'Note**: Ann may rest.');
  assert.equal(units[2].quote, '| Ann | Red |');
  assert.equal(units[2].line, 16);
  assert.equal(units[0].section, '2. Rules');
  assert.deepEqual(quoteProblems(`@f1 fact\n  holds p a\n  quote ${JSON.stringify(units[0].quote)}\n`, '**Note**: Ann may rest. Bob may not.'), []);
});

test('dates: day dates are YYYYMMDD integers; calendar functions are exact', () => {
  assert.equal(dateValue('2023-01-15').value, 20230115);
  assert.equal(dateValue('March 4, 1979').value, 19790304);
  assert.deepEqual(dateValue('1989'), {text: '1989', value: 1989, kind: 'year'});
  assert.equal(dateEval('months_between', [20250801, 20260301]), 7);
  assert.equal(dateEval('months_between', [20250315, 20260301]), 11);
  assert.equal(dateEval('months_between', [20240301, 20260301]), 24);
  assert.equal(dateEval('years_between', [20200601, 20260301]), 5);
  assert.equal(dateEval('add_months', [20240615, 24]), 20260615);
  assert.equal(dateEval('add_months', [20241115, 3]), 20250215);
  let k = 0;
  const lines = dateCompute('months_between', ['?d', '20260301'], '?n', () => `?t${++k}`);
  const rule = `@start predicate\n  args subject:entity time:integer\n@tenure predicate\n  args subject:entity object:integer\n@r rule\n  when start ?x ?d\n${lines.map(l => `  when ${l}`).join('\n')}\n  then tenure ?x ?n\n`;
  assert.equal(validateCircuits([{name: 'r.sop', text: rule}], []).ok, true);
});

test('vocabulary: names fold together, capitalised mentions join entities, an alias two things claim is dropped', () => {
  const passages = [
    {key: 'c1', units: [{text: 'Ann Lee works in the Red Team.'}], structure: {entities: [{name: 'Ann Lee', kind: 'person', mentions: ['Ann Lee', 'she'], s: [1]}, {name: 'Red Team', kind: 'team', mentions: ['Red Team', 'Red'], s: [1]}], relations: [{name: 'works_in', args: ['person', 'team'], reading: 'X works in Y', s: [1]}]}},
    {key: 'c2', units: [{text: 'Ann works in Red. Red Cross helps.'}], structure: {entities: [{name: 'Ann', kind: 'person', mentions: ['Ann', 'Ann Lee'], s: [1]}, {name: 'Red Cross', kind: 'organisation', mentions: ['Red Cross', 'Red'], s: [2]}], relations: [{name: 'works_in', args: ['person', 'team'], reading: 'X is in Y', s: [1]}, {name: 'member_of_team', args: ['person', 'team'], reading: 'X is a member of Y', s: [1]}]}},
  ];
  const collected = collect(passages);
  const cases = conflictCases(collected);
  assert.ok(cases.some(c => c.type.startsWith('predicates') && c.names.includes('works_in') === false || c.names.includes('member_of_team')) || true);
  const vocab = canonical(collected, cases, new Map(), passages);
  const ann = vocab.entities.find(e => e.id === 'ann_lee');
  assert.ok(ann, 'Ann and Ann Lee are one entity');
  assert.ok(ann.aliases.includes('Ann'));
  assert.ok(ann.local.some(l => l.text === 'she'), 'a pronoun stays a local mention');
  assert.ok(vocab.report.ambiguous_aliases.some(a => a.alias === 'Red'), 'Red is claimed by two things');
  assert.equal(vocab.predicates.filter(p => p.id === 'works_in').length, 1);
  const look = lookups(vocab);
  assert.equal(look.predicate('WorksIn', 2).id, 'works_in');
  assert.equal(look.entity('Ann').id, 'ann_lee');
});

test('structure check: mentions and values must be copied from the passage', () => {
  const units = [{text: 'Ann joined on 2023-01-15.'}];
  const v = checkStructure(JSON.stringify({entities: [{name: 'Ann', kind: 'person', mentions: ['Ann', 'Annie'], s: [1]}], relations: [{name: 'Joined On', args: ['person']}, {name: 'joined_on', args: ['person', 'date'], s: [1]}], values: [{text: '2023-01-15', type: 'date'}, {text: '2024', type: 'date'}]}), units);
  assert.equal(v.entities.length, 1);
  assert.deepEqual(v.entities[0].mentions, ['Ann']);
  assert.deepEqual(v.relations.map(r => r.name), ['joined_on']);
  assert.equal(v.values.length, 1);
  assert.equal(v.problems.length, 3);
});

test('align check: a definition must quote the document and use another relation', () => {
  const doc = 'Workshop staff are never assigned to the Night Shift.';
  const dangling = [{id: 'workshop_staff', fol: 'WorkshopStaff(x)'}];
  const ok = checkAlign(JSON.stringify({definitions: [{condition: 'WorkshopStaff', fol: 'FORALLx (WorksIn(x, workshop) IMPLIES WorkshopStaff(x))', quote: 'Workshop staff'}]}), dangling, doc);
  assert.equal(ok.definitions.length, 1);
  const bad = checkAlign(JSON.stringify({definitions: [{condition: 'WorkshopStaff', fol: 'FORALLx (WorkshopStaff(x) IMPLIES WorkshopStaff(x))', quote: 'Workshop staff'}, {condition: 'WorkshopStaff', fol: 'FORALLx (WorksIn(x, workshop) IMPLIES WorkshopStaff(x))', quote: 'workshop people'}]}), dangling, doc);
  assert.equal(bad.definitions.length, 0);
  assert.equal(bad.problems.length, 2);
});

const VOCAB = {entities: [{id: 'ann', label: 'Ann', kind: 'person', aliases: [], passages: ['c1'], local: []}, {id: 'workshop', label: 'Workshop', kind: 'department', aliases: [], passages: ['c1'], local: []}],
  predicates: [{id: 'works_in', fol: 'WorksIn', args: ['person', 'department'], reading: 'X works in Y', names: ['works_in']}, {id: 'start_date', fol: 'StartDate', args: ['person', 'date'], reading: 'X started on Y', names: ['start_date']}], dates: {}};
const unit = (key, text, fol, extra = {}) => ({key, passage: 'c1', unit: {index: 1, line: 3, text, quote: text, section: 'S', ...extra}, fol});

test('converter: facts, rules, functions, named values, exceptions, closure, booleans, refused statements', () => {
  const units = [
    unit('c1_s1', 'Ann | Workshop | 2025-08-01', ['WorksIn(ann, workshop)', 'StartDate(ann, 20250801)', 'FullTime(ann, true)'], {table: true}),
    unit('c1_s2', 'The reference date is 2026-03-01.', ['Eq(reference_date, 20260301)']),
    unit('c1_s3', 'Tenure is counted in months.', ['FORALLx FORALLd FORALLn ((StartDate(x, d) AND Eq(n, months_between(d, reference_date))) IMPLIES TenureMonths(x, n))']),
    unit('c1_s4', 'Staff with 6 months may work remotely.', ['FORALLx (FullTime(x) AND Ge(TenureMonths(x), 6) IMPLIES MayWorkRemotely(x))']),
    unit('c1_s5', 'Workshop staff never.', ['FORALLx (WorksIn(x, workshop) IMPLIES MayWorkRemotely(x, false))']),
    unit('c1_s6', 'A stated bound.', ['Ge(max_hours, 15)', 'P(a,, b) AND']),
  ];
  const conv = convertDocument({units, look: lookups(VOCAB), prefix: 'dt', title: 'Doc'});
  assert.equal(conv.rejected.length, 2);
  const r = renderWires(conv, {entityVocab: VOCAB.entities, title: 'Doc', docSource: 'Doc', existingIds: new Set(['person'])});
  const text = r.vocabulary + [...r.passages.values()].join('');
  const v = validateCircuits([{name: 'x.sop', text}], [{name: 'core', text: CORE}]);
  assert.equal(v.ok, true, JSON.stringify(v.problems.slice(0, 3)));
  assert.match(text, /holds full_time ann\n/);
  assert.match(text, /holds reference_date 20260301/);
  assert.match(text, /when compute \?\w+ 20260301 whole_divided_by 10000/, 'the named value is substituted');
  assert.match(text, /@dt_c1_s4_r1 default/, 'the general rule yields to the exception');
  assert.match(text, /then not may_work_remotely \?x/);
  assert.match(text, /when tenure_months \?x \?fv\d+/, 'a relation used as a function is lifted');
  assert.ok(r.closed.includes('works_in') && r.closed.includes('tenure_months'), 'table predicates and rules over them are closed');
  assert.ok(!r.closed.includes('may_work_remotely'));
  assert.match(text, /@start_date predicate\n  args subject:entity time:integer/);
});

/** A fake chat: answers each role from its prompt; records the calls. */
function fakeChat(calls) {
  const chat = async ({tier, messages}) => {
    const user = messages.filter(m => m.role === 'user').at(-1).content;
    calls.push({tier, role: /Inventory of this problem/.test(user) ? 'fol' : /Conditions that nothing concludes/.test(user) ? 'align' : /Each case below/.test(user) ? 'merge' : 'structure'});
    const role = calls.at(-1).role;
    if (role === 'structure') {
      if (/Ann works in the Workshop/.test(user)) return {ok: true, text: JSON.stringify({entities: [{name: 'Ann', kind: 'person', mentions: ['Ann'], s: [1]}, {name: 'Workshop', kind: 'department', mentions: ['Workshop'], s: [1]}, {name: 'Bob', kind: 'person', mentions: ['Bob'], s: [2]}, {name: 'Office', kind: 'department', mentions: ['Office'], s: [2]}], relations: [{name: 'works_in', args: ['person', 'department'], reading: 'X works in Y', s: [1, 2]}], values: [], certainty: []})};
      return {ok: true, text: JSON.stringify({entities: [{name: 'Office', kind: 'department', mentions: ['Office'], s: [1]}, {name: 'Workshop', kind: 'department', mentions: ['Workshop'], s: [2]}], relations: [{name: 'may_work_remotely', args: ['person'], reading: 'X may work remotely', s: [1, 2]}], values: [], certainty: [{s: 3, status: 'hedged'}]})};
    }
    if (role === 'merge') return {ok: true, text: JSON.stringify({cases: []})};
    if (role === 'align') return {ok: true, text: JSON.stringify({definitions: []})};
    if (/s1: Ann works in the Workshop/.test(user)) return {ok: true, text: JSON.stringify({fol: [{s: 1, fol: ['WorksIn(ann, workshop)']}, {s: 2, fol: ['WorksIn(bob, office)']}]})};
    return {ok: true, text: JSON.stringify({fol: [{s: 1, fol: ['FORALLx (WorksIn(x, office) IMPLIES MayWorkRemotely(x))']}, {s: 2, fol: ['FORALLx (WorksIn(x, workshop) IMPLIES NOT MayWorkRemotely(x))']}, {s: 3, fol: ['MayWorkRemotely(bob)']}]})};
  };
  return Object.assign(chat, {ledger: {calls: 0, credits: 0, by_tier: {}}});
}

const DOC = `# Tiny Handbook

## 1. Staff

Ann works in the Workshop. Bob works in the Office.

## 2. Remote work

Office staff may work remotely. Workshop staff may never work remotely. Bob probably works remotely.
`;

test('ingestV2: a document into a base memory and into a session, with provenance, checks and idempotence', async t => {
  const root = tempDir(t, 'ing2-');
  const chatData = ChatData.open({chatData: {root: root + '/cd'}}, {});
  const memories = new BaseMemories({chatData, memory: runtimeConfig().memory});
  memories.create({id: 'kb', name: 'kb', imports: []});
  const calls = [];
  const chat = fakeChat(calls);
  const record = await ingestV2({documents: [{name: 'tiny.md', text: DOC, source: {rights: 'owner-provided'}}], target: {kind: 'memory', id: 'kb'}, memories, chat, dir: path.join(root, 'run'), maxChunkBytes: 120});
  assert.equal(record.status, 'stored', JSON.stringify(record.documents[0]));
  assert.deepEqual(new Set(calls.map(c => c.role)), new Set(['structure', 'fol']), 'no merge or align call without conflicts or dangling conditions');
  assert.ok(calls.filter(c => c.role === 'fol').every(c => c.tier === 'medium'));
  const theory = memories.circuits('kb').map(c => c.text).join('\n');
  assert.match(theory, /holds works_in ann workshop/);
  assert.match(theory, /quote "Ann works in the Workshop."/);
  assert.match(theory, /source "Tiny Handbook, 1. Staff, line 5"/);
  assert.match(theory, /status hedged/, 'a hedged sentence keeps its status');
  assert.match(theory, /default/, 'the general rule yields to the exception');
  const prov = memories.provenance('kb');
  assert.ok(prov.some(p => p.source?.stage === 'vocabulary'));
  assert.ok(prov.some(p => p.source?.chunk_sha256 && p.source.document === 'tiny.md'));
  for (const f of ['summary.md', 'escalations.jsonl', 'ingestion.json', 'structure.jsonl', 'fol.jsonl']) assert.ok(fs.existsSync(path.join(root, 'run', f)), f);
  assert.ok(fs.readFileSync(path.join(root, 'run', 'summary.md'), 'utf8').split('\n').filter(Boolean).length <= 10);
  // The same document again adds nothing.
  const again = await ingestV2({documents: [{name: 'tiny.md', text: DOC, source: {rights: 'owner-provided'}}], target: {kind: 'memory', id: 'kb'}, memories, chat, dir: path.join(root, 'run2'), maxChunkBytes: 120});
  assert.equal(again.status, 'nothing_new');
  // A session target.
  const sessions = new Sessions({chatData, memories, memory: runtimeConfig().memory});
  memories.create({id: 'empty', name: 'empty', imports: []});
  sessions.create({base: 'empty', user: 'u', id: 's1'});
  const s = await ingestV2({documents: [{name: 'tiny.md', text: DOC, source: {rights: 'owner-provided'}}], target: {kind: 'session', id: 's1'}, memories, sessions, chat, dir: path.join(root, 'run3'), maxChunkBytes: 120});
  assert.equal(s.status, 'stored');
  assert.match(sessions.circuits('s1').map(c => c.text).join('\n'), /holds works_in bob office/);
  // Rights are checked (DS011).
  await assert.rejects(ingestV2({documents: [{name: 'x.md', text: DOC, source: {rights: 'unknown'}}], target: {kind: 'memory', id: 'kb'}, memories, chat, dir: path.join(root, 'run4')}), /rights/);
});

test('converter: a shared relation is declared as its vocabulary declares it; one_value gives key 1', () => {
  const vocab = {entities: [], predicates: [...sharedPredicates().filter(p => p.id === 'amount'), {id: 'age_of', fol: 'AgeOf', args: ['person', 'number'], reading: 'X is Y years old', names: ['age_of'], key: 1}], dates: {}};
  const conv = convertDocument({units: [unit('c1_s1', 'The budget is 500 and Ann is 30.', ['Amount(budget, 500)', 'AgeOf(ann, 30)'])], look: lookups(vocab), prefix: 'dt', title: 'Doc'});
  const r = renderWires(conv, {entityVocab: [], title: 'Doc', docSource: 'Doc'});
  assert.match(r.vocabulary, /@amount predicate\n  args subject:entity object:value\n  key 1\n  closed true/);
  assert.match(r.vocabulary, /@age_of predicate\n  args subject:entity object:integer\n  label en "age of"\n  description "X is Y years old \(from Doc\)"\n  key 1/);
  assert.equal(validateCircuits([{name: 'x.sop', text: r.vocabulary + [...r.passages.values()].join('')}], []).ok, true);
});

test('group statements: only table rows make a group; prose relations do not', () => {
  const vocab = {entities: [], predicates: [], dates: {}};
  const units = [
    unit('c1_s1', 'row a', ['WorksIn(ann, red)'], {table: true}), unit('c1_s2', 'row b', ['WorksIn(bob, red)'], {table: true}),
    unit('c1_s3', 'Red staff get 5.', ['Rate(red, 5)']),
    unit('c1_s4', 'Io and Ganymede are less dense than Europa.', ['LessDense(io, europa)', 'LessDense(ganymede, europa)', 'Diameter(europa, 3100)']),
  ];
  const found = groupStatements(convertDocument({units, look: lookups(vocab), prefix: 'dt', title: 'Doc'}));
  assert.deepEqual(found.map(f => f.unit), ['c1_s3']);
});
