// The common-sense layer commonsense-v1 (config/knowledge/commonsense-v1): it validates over core-min and core-en, every wire carries its
// provenance, the generated files carry their licence notices, and its rules answer through the product path (askMemory over a base memory
// that imports the layer): lifetimes, class disjointness, family, geography and units.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProgram} from '../../sop/knowledge/validate.mjs';
import {parse} from '../../sop/knowledge/index.mjs';
import {seedLayers, seedCircuits, ensureSeedMemories} from '../../lib/knowledge-seeds.mjs';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {Sessions} from '../../lib/chat-data/sessions.mjs';
import {TheoryCache, askMemory} from '../../reasoning/slice/index.mjs';
import {SessionStore} from '../../server/session-store.mjs';
import {cachedDir} from '../helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('commonsense-v1 validates over core-min and core-en', () => {
  const r = validateProgram(seedLayers('commonsense-v1').map(c => ({...c, role: 'knowledge'})), {authoring: true});
  assert.deepEqual(r.problems.filter(p => p.severity !== 'warning').map(p => `${p.file}:${p.line} ${p.code} ${p.message}`), []);
});

test('every fact, rule, default, integrity constraint and entity of commonsense-v1 names its source; generated files carry their licence', () => {
  for (const c of seedCircuits('commonsense-v1')) {
    for (const w of parse(c.text).wires) if (['fact', 'rule', 'default', 'integrity', 'entity'].includes(w.type)) assert.ok(w.fields.some(f => f.key === 'source'), `${c.file}: ${w.id} has no source`);
    if (/^05[0-3]/.test(c.file)) assert.match(c.text, /WordNet 3\.0 Copyright 2006 by Princeton University/, c.file);
    if (/^0540/.test(c.file)) assert.match(c.text, /Creative Commons Attribution 4\.0/, c.file);
    if (/^0540/.test(c.file)) assert.doesNotMatch(c.text, /by-sa/i, `${c.file}: a ShareAlike edge was copied`);
  }
});

const FACTS = `@cst_napoleon entity
  kind person
  label en "Napoleon"
  source "test"

@cst_einstein entity
  kind person
  label en "Albert Einstein"
  source "test"

@cst_hans entity
  kind person
  label en "Hans Albert Einstein"
  source "test"

@cst_paul entity
  kind person
  label en "Paul"
  source "test"

@cst_lyon entity
  kind city
  label en "Lyon"
  source "test"

@cst_france entity
  kind country
  label en "France"
  source "test"

@cst_europe entity
  kind continent
  label en "Europe"
  source "test"

@male_q6581097 entity
  label en "male"
  source "test"
${[['born_on cst_napoleon 1769'], ['died_on cst_napoleon 1821'], ['born_on cst_einstein 1879'], ['died_on cst_einstein 1955'], ['born_on cst_hans 1904'], ['died_on cst_hans 1973'],
  ['parent_of cst_einstein cst_hans'], ['sibling_of cst_paul cst_einstein'], ['gender cst_paul male_q6581097'], ['is_a cst_napoleon person'], ['is_a cst_lyon city'],
  ['located_in cst_lyon cst_france'], ['located_in cst_france cst_europe'], ['is_a cst_europe continent'], ['is_a cst_france country']].map(([h], i) => `@cst_f${i} fact\n  holds ${h}\n  source "test"\n`).join('\n')}`;

let tmp, sessions, theory, repo, session;
// The base memory of the test (the three seeds it imports and cs-test with FACTS, SQLite) takes over a minute to build; it is built
// once per content of the seeds, the runtime configuration and the memory code (tests/helpers.mjs cachedDir) and copied per run.
const INPUTS = ['config/knowledge/core-min', 'config/knowledge/core-en', 'config/knowledge/commonsense-v1', 'config/runtime.json', 'memory', 'lib/chat-data', 'lib/knowledge-seeds.mjs', 'sop'];
const runtime = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
const openRoot = root => {
  const config = runtime();
  config.chatData = {...config.chatData, root};
  const chatData = ChatData.open(config, {}, ROOT);
  return {config, chatData, memories: new BaseMemories({chatData, memory: config.memory})};
};
test.before(() => {
  const template = cachedDir('commonsense-layer', INPUTS, dir => {
    const {memories} = openRoot(dir);
    ensureSeedMemories(memories, {strategy: 'sqlite', ids: ['core-min', 'core-en', 'commonsense-v1']});
    memories.importMemory({id: 'cs-test', name: 'cs-test', strategy: 'sqlite', imports: ['core-min', 'core-en', 'commonsense-v1'], circuits: [{name: 'facts', text: FACTS}], approvedBy: 'test', reason: 'test'});
  }, FACTS);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commonsense-'));
  fs.cpSync(template, tmp, {recursive: true});
  const {config, chatData, memories} = openRoot(tmp);
  sessions = new Sessions({chatData, memories, memory: config.memory});
  sessions.create({base: 'cs-test', user: 'test', id: 'cs-test-session', name: 'test'});
  repo = sessions.repository('cs-test-session');
  theory = new TheoryCache().get([...sessions.baseCircuits('cs-test-session'), ...sessions.circuits('cs-test-session')]);
  const store = new SessionStore({repo, lexicon: sessions.lexicon('cs-test-session'), config: {...config, policy: {...(config.policy ?? {}), reinforce: false}}, root: path.join(tmp, 'agent')});
  session = store.get('t', 'c', 'main').agent.session;
});
test.after(() => { if (tmp) fs.rmSync(tmp, {recursive: true, force: true}); });

const ask = query => askMemory({theory, repo, session, query, budget: {timeoutMs: 60000}});
const yes = where => ask(`@q query\n  mode exists\n  where ${where}\n`).status;

test('lifetimes: older, contemporaries, and a certain "no" when one died before the other was born', () => {
  assert.equal(yes('older_than cst_napoleon cst_einstein'), 'supported');
  assert.equal(yes('contemporary_of cst_einstein cst_hans'), 'supported');
  assert.equal(yes('contemporary_of cst_einstein cst_napoleon'), 'refuted');
  assert.equal(yes('lived_before cst_napoleon cst_einstein'), 'supported');
});

test('classes: a person is not a place (disjoint classes give a certain "no")', () => {
  assert.equal(yes('is_a cst_napoleon place'), 'refuted');
});

test('family: a male sibling of a parent is an uncle, never of himself', () => {
  assert.equal(yes('uncle_of cst_paul cst_hans'), 'supported');
  assert.notEqual(yes('uncle_of cst_einstein cst_hans'), 'supported');
  assert.notEqual(yes('sibling_of cst_paul cst_paul'), 'supported');
});

test('geography and units: on a continent through containment; a kilogram is a thousand grams', () => {
  assert.equal(yes('on_continent cst_lyon cst_europe'), 'supported');
  assert.equal(yes('in_country cst_lyon cst_france'), 'supported');
  const a = ask('@q query\n  select ?n\n  where converts_to kilogram grams ?n\n');
  assert.equal(a.status, 'supported');
  assert.deepEqual(a.rows.map(r => Object.values(r)[0]), [1000]);
});
