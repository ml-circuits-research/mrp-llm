// The knowledge browser (DS022 "Knowledge browser"): read-only views of base memories and chat sessions, flags, search, cards,
// derive with proofs, and the /review page and /v1/knowledge/* API (authentication, read only, errors).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {seedCircuits, seedInfo} from '../../lib/knowledge-seeds.mjs';
import {Sessions} from '../../lib/chat-data/sessions.mjs';
import {KnowledgeBrowser} from '../../lib/review/index.mjs';
import {formSentence, inflect} from '../../lib/review/examples.mjs';
import {productServer, runtimeConfig} from '../product-helpers.mjs';
import {tempDir} from '../helpers.mjs';

const VOCABULARY = `@works_at predicate
  args subject:entity object:entity
  role subject person
  role object organization
  label en "works at"
  description "A person works at an organization."

@hires predicate
  args subject:entity object:entity
  role subject person
  role object organization
  label en "hires"

@located_in predicate
  args subject:entity location:entity
  role subject entity
  role location place
  label en "located in"
  description "An entity is located in a place."

@lx_works_at_en lexeme
  of works_at
  language en
  pos verb
  form "work at"
  frame subject object
  source "test vocabulary"

@lx_works_at_run lexeme
  of works_at
  language en
  pos verb
  form "run"
  frame subject object
  restrict object organization
  weight 10
  source "test vocabulary"

@lx_works_at_en_conv lexeme
  of works_at
  language en
  pos verb
  form "employ"
  frame object subject
  source "test vocabulary"

@operates predicate
  args subject:entity object:entity
  role subject person
  role object machine
  label en "operates"
  description "A person operates a machine."

@lx_operates_en lexeme
  of operates
  language en
  pos verb
  form "run"
  frame subject object
  restrict object machine
  weight 9
  source "test vocabulary"

@lx_hires_en lexeme
  of hires
  language en
  pos verb
  form "hire"
  frame subject object
  source "test vocabulary"

@machine entity
  kind class
  label en "machine"

@f_machine fact
  holds is_a machine entity
  source "test"

@lx_located_in_en lexeme
  of located_in
  language en
  pos copula
  form "be located in"
  frame subject location
  source "test vocabulary"

@r_works_located rule
  when works_at ?p ?o
  when located_in ?o ?c
  then located_in ?p ?c
  source "test rule"

@team entity
  kind class
  label en "team"

@f_team fact
  holds is_a team organization
  source "test"

@acme entity
  kind organization
  label en "Acme Anvils"
  alias en "Acme"

@cluj entity
  kind place
  label en "Cluj"

@f_acme_cluj fact
  holds located_in acme cluj
  source "test place"

@f_acme_description fact
  holds description acme "maker of anvils and rockets"
  source "test description"
`;

const PEOPLE = `@ana entity
  kind person
  label en "Ana Pop"

@f_ana_acme fact
  holds works_at ana acme
  source "test staff list"
`;

const DESCRIPTION = `@description predicate
  args subject:entity object:text
  label en "description"
  description "A short text that describes an entity."
`;

function memories(t) {
  const chatData = ChatData.open({chatData: {root: tempDir(t, 'kb-') + '/cd'}}, {});
  const bm = new BaseMemories({chatData, memory: runtimeConfig().memory});
  bm.importMemory({id: 'core-min', name: seedInfo('core-min').name, circuits: seedCircuits('core-min').map(({name, text}) => ({name, text})), approvedBy: 'seed'});
  bm.importMemory({id: 'vocab', name: 'Vocabulary', imports: ['core-min'], circuits: [{name: 'description', text: DESCRIPTION}, {name: 'vocabulary', text: VOCABULARY}], approvedBy: 'test', reason: 'fixture'});
  bm.importMemory({id: 'people', name: 'People', imports: ['vocab'], circuits: [{name: 'people', text: PEOPLE}], approvedBy: 'test', reason: 'fixture', source: 'test staff list'});
  return {chatData, bm};
}

const snapshot = dir => Object.fromEntries(fs.readdirSync(dir, {recursive: true}).filter(f => fs.statSync(path.join(dir, f)).isFile() && !/^repo\//.test(f)).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('knowledge browser: layers, provenance and a risk view whose flags put likely problems first', t => {
  const {bm} = memories(t);
  const browser = new KnowledgeBrowser({memories: bm});
  const view = browser.memoryView('people');
  assert.deepEqual(view.layers.map(l => [l.id, l.kind]), [['core-min', 'seed'], ['vocab', 'import'], ['people', 'own']]);
  assert.equal(view.layers[2].facts, 1);
  assert.ok(view.provenance.some(p => p.kind === 'import' && p.by === 'test' && p.source === 'test staff list'));
  const items = browser.itemPage(browser.target({memory: 'people'}), 'vocab', {limit: 100}).items;
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.ok(byKey['predicate:hires'].flags.some(f => f.code === 'no_description'), 'a predicate without a description is flagged');
  assert.ok(byKey['lexeme:lx_operates_en'].flags.some(f => f.code === 'shared_form' && /works_at/.test(f.message) && f.weight === 15), '"run" is claimed by two predicates of the same arity, told apart by restrict');
  assert.ok(byKey['lexeme:lx_works_at_en_conv'].flags.some(f => f.code === 'converse_frame'));
  assert.ok(byKey['rule:r_works_located'].flags.some(f => f.code === 'rule'));
  assert.ok(byKey['class:team']);
  assert.equal(byKey['facts:located_in'].count, 1);
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].risk >= items[i].risk, 'most risk first');
  const flagged = browser.itemPage(browser.target({memory: 'people'}), 'vocab', {flag: 'shared_form'});
  assert.ok(flagged.items.length >= 2 && flagged.items.every(i => i.flags.some(f => f.code === 'shared_form')));
  // effect, not syntax: a generated sentence with real fillers maps to the atom
  const lexeme = byKey['lexeme:lx_works_at_en'];
  const first = lexeme.examples[0];
  assert.equal(first.sentence, 'Ana Pop works at Acme Anvils');
  assert.equal(first.atom, 'works_at ana acme');
  assert.ok(first.real);
  const rule = byKey['rule:r_works_located'].examples[0];
  assert.equal(rule.real[0].head.atom, 'located_in ana cluj', 'the rule example joins the stored facts');
});

test('knowledge browser: search, entity, predicate and rule cards, derive with a proof, read only', t => {
  const {bm} = memories(t);
  const before = snapshot(bm.dir('people'));
  const browser = new KnowledgeBrowser({memories: bm});
  const target = browser.target({memory: 'people'});
  const found = browser.search(target, 'acme');
  assert.equal(found.groups.entities.items[0].id, 'acme');
  assert.equal(browser.search(target, 'acm').groups.entities.items[0].id, 'acme', 'the last word also matches as a prefix');
  assert.equal(browser.search(target, 'run').groups.predicates.total, 2, 'a lexeme form finds every predicate that claims it');
  assert.equal(browser.search(target, 'works located').groups.rules.items[0].id, 'r_works_located');
  assert.ok(browser.search(target, 'rockets').groups.facts.items.some(f => f.atom === 'description acme "maker of anvils and rockets"'), 'text values of facts are searchable');
  assert.equal(browser.search(target, 'zzzz').total, 0);
  assert.throws(() => browser.search(target, 'a '.repeat(13)), /at most 12 words/);

  const acme = browser.entity(target, 'acme');
  assert.equal(acme.label, 'Acme Anvils');
  const located = acme.facts.find(g => g.predicate === 'located_in').facts[0];
  assert.equal(located.layer, 'vocab', 'a fact of an import layer is attributed to it');
  assert.equal(located.sentence, 'Acme Anvils is located in Cluj');
  const staff = acme.facts.find(g => g.predicate === 'works_at');
  assert.equal(staff.role, 'object', 'facts in both directions');
  assert.equal(staff.facts[0].layer, 'people');
  assert.ok(acme.rules.some(r => r.id === 'r_works_located'));
  const team = browser.entity(target, 'team').classes.map(c => c.id);
  assert.ok(team.includes('class') && team.includes('organization'), 'classes are closed over is_a');
  assert.throws(() => browser.entity(target, 'nobody'), e => e.status === 404);

  const works = browser.predicate(target, 'works_at');
  assert.equal(works.layer, 'vocab');
  assert.ok(works.sentences.some(s => s.sentence === 'Acme Anvils employs Ana Pop' && s.atom === 'works_at ana acme'), 'a converse form maps back to the predicate order');
  assert.ok(works.lexemes.flatMap(l => l.forms).some(f => f.form === 'run' && f.shared_with.includes('operates')));
  assert.deepEqual(works.used_by.map(r => r.id), ['r_works_located']);
  assert.equal(works.facts_total, 1);
  const rule = browser.rule(target, 'r_works_located');
  assert.match(rule.sop, /then located_in \?p \?c/);
  assert.match(rule.english, /located_in/);

  const derived = browser.derive(target, 'ana');
  const fact = derived.derived.find(d => d.atom === 'located_in ana cluj');
  assert.ok(fact, 'the oracle derives where Ana is through the rule');
  assert.equal(fact.sentence, 'Ana Pop is located in Cluj');
  const root = fact.proof.find(n => n.id === fact.roots[0]);
  assert.equal(root.kind, 'rule');
  assert.equal(root.source, 'r_works_located');
  assert.deepEqual(fact.proof.filter(n => n.kind === 'fact').map(n => n.layer).sort(), ['people', 'vocab']);
  assert.ok(!derived.derived.some(d => d.atom === 'works_at ana acme'), 'stored facts are not reported as derived');

  assert.deepEqual(snapshot(bm.dir('people')), before, 'browsing writes nothing: circuits, manifest and provenance are unchanged');
  assert.deepEqual(fs.readdirSync(path.join(bm.dir('people'), 'repo')).filter(f => /review|browser/.test(f)), []);
});

test('knowledge browser: a chat session target adds the session layer', t => {
  const {bm, chatData} = memories(t);
  const sessions = new Sessions({chatData, memories: bm, memory: runtimeConfig().memory});
  const s = sessions.create({base: 'people', user: 'u1', id: 'sess1'});
  fs.writeFileSync(path.join(sessions.dir(s.id), 'circuits', '0001-session.sop'), '@bob entity\n  kind person\n  label en "Bob Ionescu"\n');
  const browser = new KnowledgeBrowser({memories: bm, sessions});
  const target = browser.target({session: 'sess1'}, {user: 'u1'});
  assert.deepEqual(target.layers.map(l => l.id), ['core-min', 'vocab', 'people', 'session:sess1']);
  const hit = browser.search(target, 'ionescu').groups.entities.items[0];
  assert.equal(hit.id, 'bob');
  assert.equal(hit.layer, 'session:sess1');
  assert.throws(() => browser.target({session: 'sess1'}, {user: 'someone-else'}), e => e.status === 403 || e.status === 404, 'a session is visible to its user only');
  assert.throws(() => browser.target({memory: 'people', session: 'sess1'}), /exactly one/);
});

test('examples: inflection and placeholder sentences', () => {
  assert.equal(inflect('be employed by'), 'is employed by');
  assert.equal(inflect('teach'), 'teaches');
  assert.equal(inflect('study at'), 'studies at');
  assert.equal(inflect('have a job at'), 'has a job at');
  const predicate = {id: 'works_at', roles: [{name: 'subject', type: 'person'}, {name: 'object', type: 'organization'}]};
  const ex = formSentence({lexicon: {formsByKey: new Map()}, predicate, lexeme: {pos: 'copula', frame: ['subject', 'object']}, form: 'be employed by'});
  assert.deepEqual([ex.sentence, ex.atom, ex.real], ['Ana is employed by Beta Labs', 'works_at ana beta_labs', false]);
});

test('/review and /v1/knowledge: signed in, read only, errors in the standard shape', async t => {
  const s = await productServer(t);
  const bm = s.server.memories;
  bm.importMemory({id: 'vocab', name: 'Vocabulary', imports: ['core-min'], circuits: [{name: 'description', text: DESCRIPTION}, {name: 'vocabulary', text: VOCABULARY}], approvedBy: 'test'});
  assert.equal((await s.call('/v1/knowledge/memories')).status, 401, 'no access without authentication');
  const page = await fetch(s.base + '/review', {headers: {Accept: 'text/html'}, redirect: 'manual'});
  assert.equal(page.status, 303);
  assert.match(page.headers.get('location'), /^\/login\?next=%2Freview/);
  const html = await fetch(s.base + '/review', {headers: {Cookie: s.cookie}});
  assert.equal(html.status, 200);
  const text = await html.text();
  assert.match(text, /Knowledge browser/);
  assert.match(text, /href="\/review" aria-current="page"/, 'the shared menu marks the page');
  assert.doesNotMatch(text, /[>'"]\s*(?:Accept|Reject|Approve)\s*[<'"]|\/(?:accept|reject)\b/, 'no accept, reject or approve control');
  const list = await s.user('/v1/knowledge/memories');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some(m => m.id === 'vocab' && m.layers.at(-1) === 'vocab'));
  const memory = await s.admin('/v1/knowledge/memories/vocab');
  assert.equal(memory.body.layers.at(-1).id, 'vocab');
  const items = await s.user('/v1/knowledge/memories/vocab/items?flag=no_description&limit=5');
  assert.deepEqual(items.body.items.map(i => i.id), ['hires']);
  const search = await s.user('/v1/knowledge/search?memory=vocab&q=cluj');
  assert.equal(search.body.groups.entities.items[0].id, 'cluj');
  assert.equal((await s.user('/v1/knowledge/entities/acme?memory=vocab')).body.label, 'Acme Anvils');
  assert.equal((await s.user('/v1/knowledge/predicates/works_at?memory=vocab')).body.id, 'works_at');
  assert.equal((await s.user('/v1/knowledge/rules/r_works_located?memory=vocab')).body.head, 'located_in');
  assert.equal((await s.user('/v1/knowledge/derive?memory=vocab&entity=acme')).status, 200);
  const before = fs.readFileSync(path.join(bm.dir('vocab'), 'provenance.jsonl'), 'utf8');
  for (const method of ['POST', 'DELETE']) assert.equal((await s.user('/v1/knowledge/search?memory=vocab&q=x', method)).status, 405, 'read only');
  assert.equal(fs.readFileSync(path.join(bm.dir('vocab'), 'provenance.jsonl'), 'utf8'), before);
  const missing = await s.user('/v1/knowledge/entities/acme?memory=nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'unknown_memory');
  assert.equal((await s.user('/v1/knowledge/search?memory=vocab')).body.error.code, 'invalid_parameter');
  assert.equal((await s.user('/v1/knowledge/search?memory=vocab&q=x&limit=9999')).status, 400);
  assert.equal((await s.user('/v1/knowledge/search?q=x')).body.error.code, 'invalid_parameter', 'a target is required');
  const capabilities = await s.user('/v1/capabilities');
  assert.ok(JSON.stringify(capabilities.body).includes('/v1/knowledge/search'));
});
