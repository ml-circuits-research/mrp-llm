// Document ingestion into base memories and the procedure library (DS022 "Ingesting documents into a base memory", "Procedure library").
// The coding agent is replaced by a fake author that writes fixed circuits; no test calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {Ingestions, chunkDocument, quoteProblems, memoryConflicts, withoutWires, normalizeText, checkDocuments} from '../../lib/ingest/index.mjs';
import {procedureLibrary, matchProcedures, procedureCircuit} from '../../lib/query-author/procedures.mjs';
import {runtimeConfig} from '../product-helpers.mjs';
import {tempDir} from '../helpers.mjs';

const library = t => new BaseMemories({chatData: ChatData.open({chatData: {root: tempDir(t, 'ing-') + '/cd'}}, {}), memory: runtimeConfig().memory});

const DOC = `# Tiny Handbook

## 1. Staff

Ann works in the Workshop. Bob works in the Office.

## 2. Remote work

Office staff may work remotely. Workshop staff may never work remotely.
`;

const VOCAB = `@works_in predicate
  args subject:entity object:entity
  label en "works in"
  description "the department a person works in"

`;
// What a coding agent would write for each chunk (chosen by the passage it was given).
const DRAFTS = {
  staff: `${VOCAB}@d1c1_f1 fact
  holds works_in ann workshop
  quote "Ann works in the Workshop."

@d1c1_f2 fact
  holds works_in bob office
  quote "Bob works in the Offices."
`,
  remote: `@may_work_remotely predicate
  args subject:entity
  label en "may work remotely"
  description "whether a person may work remotely"

@d1c2_r1 rule
  when all
    works_in ?p office
  end
  then may_work_remotely ?p
  quote "Office staff may work remotely."
`,
};

const fakeAuthor = calls => async ({folder, files, existing, check}) => {
  const symbols = files.find(f => f.name === 'symbols.txt');
  if (symbols) {
    calls.push({stage: 'entities', symbols: symbols.text.trim().split('\n')});
    const knowledge = symbols.text.trim().split('\n').map(s => `@${s} entity\n  label en "${s[0].toUpperCase() + s.slice(1)}"\n`).join('\n') + '\n@stray_f1 fact\n  holds works_in ann office\n';
    return {ok: true, status: 'validated', rounds: 1, circuits: [{name: 'knowledge.sop', text: knowledge}], queries: '', report: '', validation: {ok: true, problems: [], warnings: []}, usage: {cost_usd: 0}, duration_ms: 5, extra: check(knowledge)};
  }
  const passage = files[0].text;
  const knowledge = /Remote work/.test(passage) ? DRAFTS.remote : DRAFTS.staff;
  calls.push({passage: files[0].name, existing: existing.length, extra: check ? check(knowledge).map(p => p.code) : []});
  fs.mkdirSync(folder, {recursive: true});
  return {ok: true, status: 'validated', rounds: 1, circuits: [{name: 'knowledge.sop', text: knowledge}], queries: '', report: 'Not expressed: "Workshop staff may never work remotely."', validation: {ok: true, problems: [], warnings: []}, usage: {cost_usd: 0}, duration_ms: 5};
};

test('ingest: chunks follow the headings, keep coordinates and hash each chunk', () => {
  const chunks = chunkDocument(DOC, {maxBytes: 120});
  assert.equal(chunks.length, 2, 'the short title section and section 1 are packed into one chunk');
  assert.deepEqual(chunks.map(c => c.path.at(-1)), ['Tiny Handbook', '2. Remote work']);
  assert.deepEqual([chunks[1].start_line, chunks[1].end_line], [7, 10]);
  assert.match(chunks[1].text, /^## 2\. Remote work/);
  const small = chunkDocument(DOC, {maxBytes: 40});
  assert.ok(small.length > 2 && small.every(c => DOC.includes(c.text.trimEnd())), 'a section larger than the bound is cut at blank lines, never inside a paragraph');
  assert.ok(chunks.every(c => /^[0-9a-f]{64}$/.test(c.sha256)));
  assert.equal(chunkDocument(DOC).length, 1, 'a short document is one chunk');
});

test('ingest: quotes must be words of the passage; conflicts with memory are found', () => {
  assert.equal(normalizeText('It’s  a | “test”'), 'It\'s a "test"');
  const problems = quoteProblems(DRAFTS.staff, DOC);
  assert.deepEqual(problems.map(p => [p.code, p.wire]), [['quote_not_in_source', 'd1c1_f2']]);
  const stored = [{name: 'm.sop', text: `${VOCAB}@m1 fact\n  holds works_in ann workshop\n\n@m2 fact\n  holds not works_in bob office\n`}];
  const conflicts = memoryConflicts(DRAFTS.staff, stored);
  assert.deepEqual(conflicts.map(c => [c.code, c.wire]), [['duplicate_of_memory', 'd1c1_f1'], ['contradicts_memory', 'd1c1_f2']]);
  assert.doesNotMatch(withoutWires(DRAFTS.staff, ['d1c1_f2']), /d1c1_f2/);
  assert.throws(() => checkDocuments([{name: 'a.md', text: 'x', source: {rights: 'unverified'}}]), /rights/);
});

test('ingest: bad quotes are held back, validated chunks are stored with provenance at once, re-ingestion adds nothing', async t => {
  const bm = library(t);
  const memory = bm.create({name: 'policies', imports: []});
  const ingestions = new Ingestions({memories: bm});
  const calls = [];
  const draft = await ingestions.draft(memory.id, {documents: [{name: 'tiny.md', text: DOC, source: {rights: 'cleared', url: 'https://example.org/tiny'}}], maxChunkBytes: 120, author: fakeAuthor(calls)});
  assert.equal(draft.status, 'stored');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], {stage: 'entities', symbols: ['ann', 'workshop']}, 'the entity stage labels the symbols the stored facts use (not those of the rejected fact)');
  const labels = draft.chunks.find(c => c.key.endsWith('-entities'));
  assert.equal(labels.status, 'stored');
  assert.deepEqual(labels.wires, {entity: 2}, 'only entity wires are kept');
  assert.deepEqual(calls[0].extra, ['quote_not_in_source'], 'the quote check runs inside the author loop');
  assert.equal(calls[1].existing, calls[0].existing + 1, 'a later chunk sees the circuit drafted before it');
  const staff = draft.chunks.find(c => c.path.at(-1) === 'Tiny Handbook');
  assert.equal(staff.status, 'stored');
  assert.deepEqual(staff.rejected.map(r => r.wire), ['d1c1_f2'], 'a paraphrased quote is rejected, not stored');
  assert.match(fs.readFileSync(path.join(ingestions.dir(memory.id, draft.id), 'report.md'), 'utf8'), /rejected @d1c1_f2/);

  const stored = draft.stored.outcome.filter(o => o.status === 'stored');
  assert.equal(stored.length, 3, 'no manual acceptance: validated chunks are stored at the end of the ingestion');
  assert.equal(bm.manifest(memory.id).circuits, 3);
  assert.equal(bm.lexicon(memory.id).entities.ann.labels.en, 'Ann', 'questions can now link "Ann"');
  const provenance = bm.provenance(memory.id).filter(r => r.source?.kind === 'document');
  assert.equal(provenance[0].source.document, 'tiny.md');
  assert.match(provenance[0].source.chunk_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(bm.facts(memory.id, {predicate: 'works_in'}).works_in.map(r => r.args.join('>')), ['ann>workshop']);

  const again = await ingestions.draft(memory.id, {documents: [{name: 'tiny.md', text: DOC, source: {rights: 'cleared'}}], maxChunkBytes: 120, author: fakeAuthor([])});
  const skipped = again.chunks.filter(c => c.status === 'already_ingested').length;
  assert.equal(skipped, 2, 'stored chunks are skipped on re-ingestion');
  assert.ok(!again.chunks.some(c => c.key.endsWith('-entities')), 'no symbol is left without a label');
  assert.equal(again.status, 'nothing_new');
});

test('procedure library: a stored procedure bundle is matched by its question form', t => {
  const bm = library(t);
  const memory = bm.create({name: 'hr'});
  bm.addKnowledge(memory.id, {circuits: [{name: 'vocab', text: VOCAB + '@d0_f1 fact\n  holds works_in bob office\n  source "test"\n'}], approvedBy: 'tester'});
  const circuit = procedureCircuit({id: 'proc_remote', description: 'Answers: may <person> work remotely?', definitions: DRAFTS.remote});
  bm.addKnowledge(memory.id, {circuits: [{name: 'procedure-remote', text: circuit}], approvedBy: 'tester'});
  const circuits = bm.layeredCircuits(memory.id);
  const lib = procedureLibrary(circuits);
  assert.deepEqual(lib.procedures.map(p => [p.id, p.heads]), [['proc_remote', ['may_work_remotely']]]);
  assert.deepEqual(matchProcedures('May Bob work remotely from home?', lib).map(m => m.id), ['proc_remote']);
  assert.deepEqual(matchProcedures('How many people work in the office?', lib), []);
  assert.throws(() => procedureCircuit({id: 'Bad', description: 'x', definitions: DRAFTS.remote}), /lowercase/);
});

test('ingest API: the direct author (stub chat) ingests and stores, report, procedure', async t => {
  const {productServer} = await import('../product-helpers.mjs');
  const s = await productServer(t);
  const created = await s.user('/v1/memories', 'POST', {name: 'tiny policies', id: 'tiny'});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const refused = await s.user('/v1/memories/tiny/ingest', 'POST', {documents: [{name: 'x.md', text: DOC, source: {rights: 'unverified'}}]});
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'rights_required');
  const drafted = await s.user('/v1/memories/tiny/ingest', 'POST', {documents: [{name: 'tiny.md', text: DOC.split('## 2.')[0], source: {rights: 'cleared'}}]});
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  assert.equal(drafted.body.status, 'stored');
  assert.match(drafted.body.report, /## Stored/);
  const listed = await s.user('/v1/memories/tiny/ingestions');
  assert.equal(listed.body.data[0].id, drafted.body.id);
  assert.equal(drafted.body.stored.outcome[0].status, 'stored');
  assert.equal((await s.user(`/v1/memories/tiny/ingestions/${drafted.body.id}/accept`, 'POST', {})).status, 404, 'there is no acceptance endpoint');
  const proc = await s.user('/v1/memories/tiny/procedures', 'POST', {id: 'proc_remote', description: 'Answers: may <person> work remotely?', definitions: DRAFTS.remote});
  assert.equal(proc.status, 200, JSON.stringify(proc.body));
  assert.equal(proc.body.memory.circuits, 2);
});
