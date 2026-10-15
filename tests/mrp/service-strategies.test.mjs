// The strategies that use the strategy service (DependencyScaffold, SpladeRouted, SaeRouted, FrameGuided, frame-seed, the SAE discover
// strategies, the retrieve strategies, the embedding round trip), with fake service calls and fake model clients: no Python, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Lexicon} from '../../sop/lexicon.mjs';
import {skeletonOf, circuitOf, dependencyScaffold} from '../../lib/formalize/scaffold.mjs';
import {spladeSelect, saeSelect, routedExtractors} from '../../lib/formalize/routed-extractors.mjs';
import {retrieveCandidates, predicateDocuments, factsOf, graphWalk} from '../../lib/mrp/retrieve.mjs';
import {frameSeed, frameGuided} from '../../lib/mrp/frames.mjs';
import {saeDiscover} from '../../lib/mrp/discover-sae.mjs';
import {servicePython} from '../../lib/mrp/strategy-service.mjs';
import {Models} from '../../lib/mrp/models.mjs';
import {createMrpPipeline} from '../../lib/mrp/pipeline.mjs';

const MEMORY = `@person entity
  kind class
  label en "person"
@organization entity
  kind class
  label en "organization"
@works_at predicate
  args subject:entity object:entity
  label en "works at"
@lx_works_at_en lexeme
  of works_at
  language en
  pos verb
  form "work at"
  frame subject object
@parent_of predicate
  args subject:entity object:entity
  label en "parent of"
@ana entity
  kind person
  label en "Ana"
@acme entity
  kind organization
  label en "Acme"
@f1 fact
  holds works_at ana acme
@f2 fact
  holds parent_of ana acme
@s_company schema
  name "company"
  predicate ~works_at
@ex_company extractor
  schema ~s_company
  strategy SchemaGuidedLLM
  trigger "work"
  trigger "feature:sae:demo:7"
`;
const circuits = [{name: 'm', text: MEMORY}];
const lexicon = Lexicon.fromCircuits(circuits);

/** spaCy-shaped tokens: [text, lemma, pos, tag, dep, head]. */
const toks = rows => rows.map(([text, lemma, pos, tag, dep, head], i) => ({i, text, lemma, pos, tag, dep, head, ent: null}));
const WHO_WORKS = toks([['Who', 'who', 'PRON', 'WP', 'nsubj', 1], ['works', 'work', 'VERB', 'VBZ', 'ROOT', 1], ['at', 'at', 'ADP', 'IN', 'prep', 1], ['Acme', 'Acme', 'PROPN', 'NNP', 'pobj', 2], ['?', '?', 'PUNCT', '.', 'punct', 1]]);

test('DependencyScaffold: the skeleton of a parse, its circuit, and a turn that links the phrase with no model call', async () => {
  assert.deepEqual(skeletonOf(WHO_WORKS), {phrase: 'work at', subject: '?x', object: 'Acme', asked: true, count: false, negated: false});
  const passive = toks([['Who', 'who', 'PRON', 'WP', 'nsubjpass', 2], ['is', 'be', 'AUX', 'VBZ', 'auxpass', 2], ['employed', 'employ', 'VERB', 'VBN', 'ROOT', 2], ['by', 'by', 'ADP', 'IN', 'agent', 2], ['Acme', 'Acme', 'PROPN', 'NNP', 'pobj', 3]]);
  assert.deepEqual(skeletonOf(passive), {phrase: 'employ', subject: 'Acme', object: '?x', asked: true, count: false, negated: false}, 'a passive turns active');
  const join = toks([['Who', 'who', 'PRON', 'WP', 'nsubj', 1], ['works', 'work', 'VERB', 'VBZ', 'ROOT', 1], ['and', 'and', 'CCONJ', 'CC', 'cc', 1], ['lives', 'live', 'VERB', 'VBZ', 'conj', 1]]);
  assert.equal(skeletonOf(join), null, 'a coordination is a join: not read');
  assert.match(circuitOf(skeletonOf(WHO_WORKS), 'work at'), /select \?x\n  where match\n    relation "work at"\n    role subject \?x\n    role object "Acme"/);
  let calls = 0;
  const s = dependencyScaffold({tier: 'tiny', client: {chat: async () => { calls++; return {ok: true, text: '{"predicate": null}'}; }}, parse: async () => ({tokens: WHO_WORKS})});
  const r = await s.run({message: 'Who works at Acme?', lexicon, circuits});
  assert.equal(r.ok, true, JSON.stringify(r.validation?.problems));
  assert.equal(r.linked, 'phrase');
  assert.equal(calls, 0, 'a phrase the memory has needs no model');
});

test('SpladeRouted and SaeRouted: triggers select the extractors, which run over their schema; nothing fired is unclear', async () => {
  assert.deepEqual(spladeSelect(lexicon.extractors, {work: 1.2, acme: 2}).map(r => r.fired), [['work']]);
  assert.deepEqual(spladeSelect(lexicon.extractors, {apple: 1}), []);
  assert.deepEqual(saeSelect(lexicon.extractors, new Map([['sae:demo', new Set([7])]])).map(r => r.fired), [['feature:sae:demo:7']]);
  const schemaGuided = {tier: 'small', tag: 'tier:small@pworker#SchemaGuidedLLM', run: async args => ({ok: true, status: 'validated', sop: '@q query\n', only: args.only})};
  const fakeCall = vec => async (slot, op) => op === 'splade' ? {vectors: [vec]} : {features: [[{id: 7, value: 1}]]};
  const hit = await routedExtractors({kind: 'splade', schemaGuided, call: fakeCall({work: 1})}).run({message: 'Who is employed by Acme?', lexicon});
  assert.deepEqual(hit.only, ['works_at']);
  assert.equal(hit.routing.extractors[0].id, 'ex_company');
  const miss = await routedExtractors({kind: 'splade', schemaGuided, call: fakeCall({banana: 1})}).run({message: 'What is a banana?', lexicon});
  assert.equal(miss.unclear, 'relation_not_in_memory');
  assert.equal((await routedExtractors({kind: 'sae', schemaGuided, call: fakeCall({})}).run({message: 'x', lexicon})).only[0], 'works_at');
});

test('retrieve strategies: predicate documents, graph walk, and SPLADE/dense ranking over a stored index', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-index-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const docs = predicateDocuments(lexicon, factsOf(circuits));
  assert.match(docs.find(d => d.predicate === 'works_at').text, /^works at\. phrases: work at\. examples: Ana works at Acme$/);
  assert.equal(graphWalk({english: 'Who is Ana?', lexicon, circuits})[0].id, 'works_at');
  const encode = kind => async texts => texts.map(text => kind === 'splade' ? Object.fromEntries(text.toLowerCase().match(/[a-z]+/g).map(w => [w, 1])) : [/work|employ/i.test(text) ? 1 : 0, /parent|child/i.test(text) ? 1 : 0]);
  const splade = await retrieveCandidates({strategy: 'splade-slice', memory: 'm', english: 'who works at acme', lexicon, circuits, encode, dir});
  assert.equal(splade.predicates[0].id, 'works_at');
  const dense = await retrieveCandidates({strategy: 'dense-slice', memory: 'm', english: 'Who is employed by Acme?', lexicon, circuits, encode, dir});
  assert.equal(dense.predicates[0].id, 'works_at');
  assert.equal(fs.readdirSync(path.join(dir, 'm')).length, 2, 'one stored index per kind');
  assert.equal(await retrieveCandidates({strategy: 'slice', memory: 'm', english: 'x', lexicon, circuits}), null);
  const hybrid = await retrieveCandidates({strategy: 'hybrid-rerank', memory: 'm', english: 'who works at acme', lexicon, circuits, encode, dir});
  assert.equal(hybrid.predicates[0].id, 'works_at');
});

test('frame-seed proposes frame units that are WordNet synonyms; FrameGuided routes by the frames the message evokes', async () => {
  const call = async (slot, op, input) => {
    if (op === 'framenet') return {frames: Object.fromEntries(input.lemmas.map(l => [l, l.startsWith('work') || l.startsWith('employ') ? [{frame: 'Being_employed', elements: []}] : []]))};
    if (op === 'units') return {units: {Being_employed: ['work.v', 'labor.v', 'employee.n']}};
    if (op === 'synonyms') return {synonyms: {work: ['labor', 'toil']}};
    if (op === 'spacy') return {tokens: toks([['Who', 'who', 'PRON', 'WP', 'nsubj', 1], ['is', 'be', 'AUX', 'VBZ', 'auxpass', 2], ['employed', 'employ', 'VERB', 'VBN', 'ROOT', 2]])};
    throw new Error(op);
  };
  const seed = await frameSeed({lexicon, validate: () => ({ok: true}), call});
  assert.deepEqual(seed.proposed.map(p => [p.predicate, p.form]), [['works_at', 'labor']]);
  assert.match(seed.proposed[0].text, /@lx_works_at_fn_labor lexeme\n {2}of works_at\n/);
  const schemaGuided = {tier: 'small', tag: 'tier:small@pworker#SchemaGuidedLLM', run: async args => ({ok: true, only: args.only})};
  const routed = await frameGuided({schemaGuided, call}).run({message: 'Who is employed by Acme?', lexicon: Lexicon.fromCircuits(circuits)});
  assert.deepEqual(routed.only, ['works_at']);
});

test('SAE discover: named features become a proposed schema and an extractor with the feature trigger; generic predicates are not offered', async () => {
  const call = async () => ({features: [{id: 3, passages: [0], count: 1}, {id: 9, passages: [1], count: 1}]});
  const prompts = [];
  const run = async (name, inputs) => { prompts.push(...inputs.map(i => i.feature)); return [{ok: true, value: {name: 'employment', description: 'who works where', predicates: ['works_at']}, requests: 1}, {ok: true, value: {name: 'kinds', predicates: ['is_a']}, requests: 1}]; };
  const out = await saeDiscover({strategy: 'sae-sentence-embeddings', passages: ['Ana works at Acme.', 'Ana is a person.'], run, lexicon, validate: () => ({ok: true}), model: 'demo', call, now: new Date('2026-10-15T09:00:00Z')});
  assert.equal(out.proposed.length, 1);
  assert.match(out.proposed[0].text, /@s_employment_3 schema[\s\S]*status proposed[\s\S]*predicate ~works_at[\s\S]*@ex_employment_3 extractor\n {2}schema ~s_employment_3\n {2}strategy SaeRouted\n {2}trigger "feature:sae:demo_202610150900:3"/);
  assert.equal(out.skipped[0].reason, 'no predicate of the memory fits');
  assert.match(prompts[0], /works_at: works at/);
  assert.doesNotMatch(prompts[0], /\bis_a\b/);
});

test('roundtrip embedding compares the restatement and the message by the cosine of their embeddings', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-emb-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const models = new Models({root});
  models.create({id: 'm', slots: {normalize: 'passthrough', roundtrip: 'embedding'}});
  const service = async (slot, op, input) => ({vectors: input.texts.map(text => /Acme/.test(text) ? [1, 0] : [0, 1])});
  const mrp = createMrpPipeline({models, service, client: () => ({chat: async () => ({ok: true, text: 'Who works at Globex?'})})});
  const slot = models.effective('m').slots.roundtrip;
  const r = await mrp.roundtrip(slot, {english: 'Who works at Acme?', modelSop: '@q query\n  select ?x\n  where works_at ?x acme\n', parse: null}, []);
  assert.equal(r.score, 0);
  assert.equal(r.agree, false);
});

test('the lexicon keeps extractor wires through its cache, and the service Python is the private environment when it exists', () => {
  const revived = Lexicon.revive(JSON.parse(JSON.stringify(lexicon.serialize())));
  assert.deepEqual(revived.extractors.map(x => [x.id, x.schema, x.triggers]), [['ex_company', 's_company', ['work', 'feature:sae:demo:7']]]);
  assert.equal(servicePython({MRP_PYTHON: '/x/python'}), '/x/python');
  assert.match(servicePython({}), /mrp-env\/bin\/python$|^python3$/);
});

test('CNL-ACE: a DRS becomes the skeleton; a refused rewrite goes back once with APE\'s message; schema-linker writes the schema id', async () => {
  const {skeletonOfDrs, cnlAce} = await import('../../lib/formalize/cnl-ace.mjs');
  const c = (name, ...args) => ({name, args});
  assert.deepEqual(skeletonOfDrs([c('query', 'A', 'who'), c('predicate', 'B', 'works', 'A'), c('modifier_pp', 'B', 'at', 'named(Acme)')]), {phrase: 'work at', subject: '?x', object: 'Acme', asked: true, count: false, negated: false});
  assert.deepEqual(skeletonOfDrs([c('object', 'A', 'grandparent', 'countable', 'na', 'eq', '1'), c('relation', 'A', 'of', 'named(Carina)'), c('predicate', 'B', 'be', 'named(Ana)', 'A')]), {phrase: 'grandparent of', subject: 'Ana', object: 'Carina', asked: false, count: false, negated: false});
  assert.equal(skeletonOfDrs([c('predicate', 'A', 'work', 'named(X)'), c('predicate', 'B', 'live', 'named(X)')]), null, 'two predicates are a join');
  const prompts = [];
  const client = {chat: async o => { prompts.push(o.prompt); return {ok: true, text: prompts.length === 1 ? 'Who works at Acme' : 'Who v:works at p:Acme?'}; }};
  const parse = ace => ace.includes('v:') ? {ok: true, conditions: [c('query', 'A', 'who'), c('predicate', 'B', 'works', 'A'), c('modifier_pp', 'B', 'at', 'named(Acme)')]} : {ok: false, conditions: [], error: 'Use the prefix n:, v:, a: or p:.'};
  const r = await cnlAce({tier: 'small', client, parse}).run({message: 'Who works at Acme?', lexicon, circuits, link: 'schema-linker'});
  assert.equal(r.ok, true, JSON.stringify(r.validation?.problems));
  assert.equal(r.ace, 'Who v:works at p:Acme?');
  assert.match(prompts[1], /APE REFUSED IT: Use the prefix/);
  assert.equal(r.linked, 'schema', 'the reviewed schema of the memory names works_at for "work at"');
  assert.match(r.sop, /relation "works_at"/);
});

test('FineTunedSOP: the compact prompt holds the candidates with their roles; one validation, no repair', async () => {
  const {finetunedPrompt, finetunedCandidates, finetunedStrategy} = await import('../../lib/formalize/finetuned.mjs');
  const candidates = finetunedCandidates('Who works at Acme?', lexicon, {must: 'parent_of'});
  assert.ok(candidates.some(x => x.id === 'works_at') && candidates.some(x => x.id === 'parent_of'));
  assert.match(finetunedPrompt('Who works at Acme?', candidates), /^PREDICATES:\n[\s\S]*works_at\(subject, object\): works at[\s\S]*\nQUESTION: Who works at Acme\?\nCIRCUIT:$/);
  const circuit = '@q query\n  select ?x\n  where match\n    relation "works_at"\n    role subject ?x\n    role object "Acme"\n    polarity affirmed\n  end\n';
  let calls = 0;
  const s = finetunedStrategy({tier: 'finetuned', client: {chat: async () => { calls++; return {ok: true, text: circuit}; }}});
  const r = await s.run({message: 'Who works at Acme?', lexicon, circuits});
  assert.equal(r.ok, true);
  assert.equal(calls, 1);
  const {questionsOf} = await import('../../tools/finetune/pairs.mjs');
  assert.deepEqual(questionsOf({id: 'works_at', roles: ['subject', 'object'], form: 'work at', pos: 'verb', converse: false, a: 'Mira Holt', b: 'Zentrix'}).map(q => q.question), ['Who works at Zentrix?', 'What does Mira Holt work at?', 'Does Mira Holt work at Zentrix?']);
  assert.equal(questionsOf({id: 'p', roles: ['subject', 'object'], form: 'typically found at', pos: 'verb', converse: false, a: 'a', b: 'b'})[0].question, 'Who is typically found at b?', 'a participle reads as a copula');
});

test('the Soufflé lowering never divides by zero: the divisor is rewritten, the guard stays', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../../reasoning/strategies/datalog-souffle/lower.mjs', import.meta.url), 'utf8');
  assert.match(source, /\(\$\{b\} \+ 1 - min\(1, max\(\$\{b\}, -\(\$\{b\}\)\)\)\)/);
  assert.match(source, /if \(l\.word === 'whole_divided_by'\) out\.push\(`\$\{b\} != 0`\);/);
});
