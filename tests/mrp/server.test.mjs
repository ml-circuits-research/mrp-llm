import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {productServer} from '../product-helpers.mjs';
import {createMrpRoutes} from '../../server/mrp-routes.mjs';

/** A fake model client for the MRP slots: normalize returns the English message, voice prefixes the answer with "[ro]". */
const fakeClient = () => purpose => ({chat: async ({prompt}) => {
  if (purpose === 'normalize') { const text = prompt.split('MESSAGE:\n').at(-1); return {ok: true, text: JSON.stringify({language: /Cine/.test(text) ? 'ro' : 'en', english: /Cine/.test(text) ? 'Does Ana like Alpha Lab?' : text, changed: true})}; }
  if (purpose === 'voice') { const m = /(?:ANSWER|DRAFT REPLY):\n([\s\S]*?)\n\n/.exec(prompt); return {ok: true, text: '[ro] ' + (m?.[1] ?? '')}; }
  return {ok: false, reason: 'not faked'};
}});

const MODEL = {id: 'demo-mrp', name: 'Demo', base: 'default', faq: [{q: 'What are your opening hours?', a: 'From 9 to 17.'}],
  slots: {normalize: 'translate-llm', reflex: 'faq-fixed', formalize: 'LocalLLMStepByStep', roundtrip: 'off', voice: 'translate-only', commit: 'never'}};

async function server(t) {
  const s = await productServer(t, {config: {mrp: {defaultModel: 'demo-mrp', client: fakeClient()}}});
  const made = await s.user('/v1/mrp/models', 'POST', MODEL);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return s;
}

test('GET /v1/models lists the MRP models; the chat answers through the model: normalize, core, voice', async t => {
  const s = await server(t);
  const models = await s.user('/v1/models');
  assert.ok(models.body.data.some(m => m.id === 'demo-mrp' && m.owned_by === 'mrp-llm' && m.mrp.base === 'default'));
  const r = await s.user('/v1/chat/completions', 'POST', {model: 'demo-mrp', conversation_id: 'c1', messages: [{role: 'user', content: 'Cine o place pe Ana?'}]});
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600));
  assert.equal(r.body.model, 'demo-mrp');
  assert.equal(r.body.mrp.english, 'Does Ana like Alpha Lab?');
  assert.equal(r.body.mrp.language, 'ro');
  assert.equal(r.body.mrp.output, 'ro');
  assert.match(r.body.choices[0].message.content, /^\[ro\] /);
  assert.ok(r.body.chatSop.english_text);
  assert.deepEqual(r.body.mrp.trace.map(x => x.slot), ['normalize', 'affect', 'reflex', 'roundtrip', 'voice']);
  assert.equal(r.body.chatSop.session.model, 'demo-mrp');
});

test('a FAQ reflex answers without the formalizer; metadata.language overrides the answer language', async t => {
  const s = await server(t);
  const r = await s.user('/v1/chat/completions', 'POST', {model: 'demo-mrp', conversation_id: 'c2', metadata: {language: 'ro'}, messages: [{role: 'user', content: 'What are your opening hours?'}]});
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600));
  assert.equal(r.body.chatSop.status, 'reflex');
  assert.equal(r.body.mrp.reflex.answer, 'From 9 to 17.');
  assert.equal(r.body.mrp.output, 'ro');
  assert.equal(r.body.choices[0].message.content, '[ro] From 9 to 17.');
  const bad = await s.user('/v1/chat/completions', 'POST', {model: 'demo-mrp', metadata: {temperature: 1}, messages: [{role: 'user', content: 'hi'}]});
  assert.equal(bad.status, 400);
});

test('model CRUD, effective configuration, catalog, the /models page and the commit policy never', async t => {
  const s = await server(t);
  assert.equal((await s.user('/v1/mrp/models/demo-mrp')).body.state.reflex, undefined);
  const upd = await s.user('/v1/mrp/models/demo-mrp', 'PUT', {slots: {...MODEL.slots, reflex: {strategy: 'faq-margin', params: {margin: 0.2}}}});
  assert.equal(upd.status, 200);
  assert.equal((await s.user('/v1/mrp/models/demo-mrp/effective')).body.slots.reflex.params.margin, 0.2);
  assert.equal((await s.user('/v1/mrp/models', 'POST', {id: 'x', slots: {reflex: 'telepathy'}})).status, 400);
  const cat = await s.user('/v1/mrp/strategies');
  assert.ok(cat.body.data.find(sl => sl.id === 'roundtrip').strategies.length >= 4);
  assert.equal((await s.admin('/models')).status, 200);
  const session = await s.user('/v1/sessions', 'POST', {settings: {model: 'demo-mrp'}});
  assert.equal(session.status, 201);
  assert.equal(session.body.base.id, 'default');
  assert.equal((await s.user(`/v1/sessions/${session.body.id}/settings`, 'POST', {slots: {reflex: 'telepathy'}})).status, 400);
  assert.equal((await s.user(`/v1/sessions/${session.body.id}/settings`, 'POST', {model: 'nope'})).status, 400);
  assert.equal((await s.user('/v1/sessions', 'POST', {settings: {model: 'nope'}})).status, 400);
  const commit = await s.user(`/v1/sessions/${session.body.id}/commit`, 'POST', {name: 'x'});
  assert.equal(commit.status, 403);
  assert.equal(commit.body.error.code, 'commit_refused');
  assert.equal((await s.user('/v1/mrp/models/demo-mrp', 'DELETE')).status, 200);
});

test('the model gateway settings need the administrator session and never return a key', async t => {
  const s = await server(t);
  assert.equal((await s.user('/v1/mrp/pworker')).status, 403);
  const saved = [];
  const fakeAdmin = {
    proxyPid: async () => null, listProviders: () => [{name: 'deepseek', keyConfigured: saved.length > 0}], listTiers: () => ({tiers: {fast: [{upstream: 'deepseek', model: 'deepseek-flash'}]}, batching: {}}),
    setProviderKey: async (name, key) => { saved.push([name, key]); return {provider: name, keyConfigured: Boolean(key), models: 3}; },
    setTierChain: async (tier, entries) => ({tier, entries}), removeTier: () => true, restartProxy: async () => true, providerCatalog: async () => [{id: 'deepseek-flash'}], saveCustomProvider: async name => ({provider: name, models: 1}),
  };
  const routes = createMrpRoutes({models: s.server.models, memories: null, admin: fakeAdmin, json: (res, status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); },
    readBody: async req => { let b = ''; for await (const c of req) b += c; return JSON.parse(b || '{}'); }});
  const srv = http.createServer((req, res) => routes.handle(req, res, req.url.split('?')[0], {admin: true, user: 'admin'}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const put = await fetch(base + '/v1/mrp/pworker/providers/deepseek/key', {method: 'PUT', body: JSON.stringify({key: 'sk-secret-1'})}).then(r => r.json());
  assert.deepEqual(saved, [['deepseek', 'sk-secret-1']]);
  assert.equal(put.keyConfigured, true);
  const view = await fetch(base + '/v1/mrp/pworker').then(r => r.text());
  assert.ok(!view.includes('sk-secret-1'));
  assert.match(view, /"keyConfigured":true/);
  const bad = await fetch(base + '/v1/mrp/pworker/providers/deepseek/key', {method: 'PUT', body: JSON.stringify({key: 'has space'})});
  assert.equal(bad.status, 400);
  const tier = await fetch(base + '/v1/mrp/pworker/tiers/fast', {method: 'PUT', body: JSON.stringify({entries: [{provider: 'deepseek', model: 'deepseek-flash', extraBody: {thinking: {type: 'disabled'}}}]})}).then(r => r.json());
  assert.equal(tier.restart_needed, true);
});

test('GET /v1/mrp/tiers shows every tier with its chain and what it serves, to every user, without keys', async t => {
  const s = await server(t);
  const fakeAdmin = {proxyPid: async () => null, listTiers: () => ({tiers: {fast: [{upstream: 'deepseek', model: 'deepseek-flash', extraBody: {thinking: {type: 'disabled'}}}], quick: 'fast'}, batching: {}})};
  const routes = createMrpRoutes({models: s.server.models, memories: null, admin: fakeAdmin, json: (res, status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); }, readBody: async () => ({})});
  const srv = http.createServer((req, res) => routes.handle(req, res, req.url.split('?')[0], {admin: false, user: 'u'}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const body = await fetch(`http://127.0.0.1:${srv.address().port}/v1/mrp/tiers`).then(r => r.json());
  assert.deepEqual(body.data, [
    {tier: 'fast', alias: null, chain: [{provider: 'deepseek', model: 'deepseek-flash', thinking: 'off', reasoning_effort: null, minTokens: null}], serves: null, fallback: [], error: 'the Ploinky proxy is not running'},
    {tier: 'quick', alias: 'fast', chain: [], serves: null, fallback: [], error: 'the Ploinky proxy is not running'},
  ]);
  assert.equal((await s.user('/v1/mrp/tiers')).status, 200);
});

test('a Symbolic Model on several base memories gets one composed memory, rebuilt when the choice changes', async t => {
  const s = await server(t);
  const made = await s.user('/v1/mrp/models', 'POST', {id: 'multi', memories: ['acme-demo', 'assistant-v1']});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.base, 'sm-multi');
  assert.deepEqual(made.body.memories, ['acme-demo', 'assistant-v1']);
  const composed = await s.user('/v1/memories/sm-multi');
  assert.equal(composed.status, 200);
  assert.deepEqual(composed.body.composition?.layers ?? composed.body.memory?.composition?.layers ?? (composed.body.imports ?? []).map(l => l.id ?? l), ['acme-demo', 'assistant-v1']);
  const one = await s.user('/v1/mrp/models/multi', 'PUT', {memories: ['demo']});
  assert.equal(one.body.base, 'demo');
  const clash = await s.user('/v1/mrp/models/multi', 'PUT', {memories: ['demo', 'core-en']});
  assert.equal(clash.status, 422);
  assert.match(clash.body.error.message, /duplicate_id/);
  assert.equal((await s.user('/v1/mrp/models', 'POST', {id: 'bad', memories: ['nope', 'demo']})).status, 404);
  assert.equal((await s.user('/v1/mrp/models', 'POST', {id: 'bad2', memories: []})).status, 400);
});

test('discover llm-consolidate: batches name relations, synonyms merge, valid candidates become review items; known names are not proposed', async t => {
  const calls = [];
  const client = purpose => ({chat: async ({tier, prompt}) => {
    calls.push({purpose, tier});
    if (/merge synonymous/.test(prompt)) return {ok: true, text: JSON.stringify({groups: [['ships_to', 'delivers_to']]})};
    const extract = text => /PASSAGE 1:\nAcme ships/.test(text)
      ? {predicates: [{name: 'ships to', roles: ['subject', 'object'], kinds: ['organization', 'city'], description: 'An organization ships goods to a place.', forms: ['ship to']}, {name: 'member of project', roles: ['subject', 'object'], forms: ['works on']}]}
      : {predicates: [{name: 'delivers_to', roles: ['subject', 'object'], description: 'Delivers goods to a place.', forms: ['deliver to']}, {name: 'bad name!', roles: []}]};
    // Ploinky's prompt batching: one request lists the batches as [{id, input}] and expects {results: {id: result}}.
    if (/Several independent requests follow/.test(prompt)) { const list = JSON.parse(prompt.slice(prompt.lastIndexOf('\n['))); return {ok: true, text: JSON.stringify({results: Object.fromEntries(list.map(r => [r.id, extract(r.input)]))})}; }
    return {ok: true, text: JSON.stringify(extract(prompt))};
  }});
  const s = await productServer(t, {config: {mrp: {defaultModel: 'shop', client}}});
  assert.equal((await s.user('/v1/mrp/models', 'POST', {id: 'shop', base: 'acme-demo'})).status, 201);
  assert.equal((await s.user('/v1/mrp/models/shop/discover', 'POST', {passages: ['x']})).status, 400, 'the default discover strategy manual runs nothing');
  assert.equal((await s.user('/v1/mrp/models/shop/discover', 'POST', {strategy: 'sae-pretrained-dictionary', passages: ['x']})).status, 503);
  const r = await s.user('/v1/mrp/models/shop/discover', 'POST', {strategy: 'llm-consolidate', passages: ['Acme ships parts to Cluj every week. '.repeat(20), 'Globex delivers boxes to Bucharest. '.repeat(20)], params: {batchChars: 1000}});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.batches, 2);
  assert.equal(r.body.calls, 2, 'the two batches share one request (Ploinky prompt batching), plus one unifying call');
  assert.ok(calls.every(c => c.tier === 'good' && c.purpose === 'job:discover'));
  assert.deepEqual(r.body.known, [{name: 'member_of_project', predicate: 'project_member'}], 'a phrase the memory already has is known, not proposed');
  assert.equal(r.body.proposed.length, 1, JSON.stringify(r.body));
  assert.deepEqual(r.body.proposed[0].synonyms, ['delivers_to']);
  assert.match(r.body.proposed[0].text, /^@ships_to predicate\n  args subject:entity object:entity\n/);
  assert.match(r.body.proposed[0].text, /form "deliver to"/);
  assert.ok(!r.body.unused.includes('project_member'), 'a predicate the corpus named is not unused');
  assert.ok(!r.body.unused.includes('is_a'), 'unused lists only the predicates of the model\'s own memory, not its imports');
  assert.match(r.body.schema.text, /schema\n[\s\S]*  status proposed\n[\s\S]*  predicate ~ships_to\n/);
  const queue = await s.user('/v1/mrp/models/shop/review');
  const item = queue.body.data.find(i => i.kind === 'schema');
  assert.equal(item.source, 'discover:llm-consolidate');
  const ok = await s.user(`/v1/mrp/models/shop/review/${item.id}/approve`, 'POST');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.written, 1);
  const record = queue.body.data.find(i => i.kind === 'schema-record');
  assert.equal((await s.user(`/v1/mrp/models/shop/review/${record.id}/approve`, 'POST')).status, 200);
  const {Lexicon} = await import('../../sop/lexicon.mjs');
  const lexicon = Lexicon.fromCircuits(s.server.memories.layeredCircuits('acme-demo'));
  assert.ok(Object.values(lexicon.schemas).some(x => x.provenance === 'llm-consolidate' && x.status === 'reviewed' && x.predicates.includes('ships_to')), 'the approved record is a reviewed schema');
  const again = await s.user('/v1/mrp/models/shop/discover', 'POST', {strategy: 'llm-consolidate', passages: ['Acme ships parts to Cluj every week.'], params: {batchChars: 1000}});
  assert.ok(again.body.known.some(k => k.name === 'ships_to'), 'an approved predicate is known on the next run (a difference, never an overwrite)');
});

test('the acme-demo memory carries a reviewed value schema: its predicates are the closed vocabulary of SchemaGuidedLLM', async t => {
  const {Lexicon} = await import('../../sop/lexicon.mjs');
  const s = await productServer(t, {config: {mrp: {client: fakeClient()}}});
  const layered = s.server.memories.layeredCircuits('acme-demo');
  assert.ok(layered.some(c => /s_acme_company schema/.test(c.text)), 'the seed schema is a circuit of the memory');
  const lexicon = Lexicon.fromCircuits(layered);
  assert.equal(lexicon.schemas.s_acme_company.status, 'reviewed');
  assert.deepEqual(lexicon.reviewedSchemaPredicates().sort(), ['colleague_of', 'grandparent_of', 'has_occupation', 'lives_in', 'located_in', 'manages', 'parent_of', 'project_member', 'works_at']);
  const bad = await s.user('/v1/memories/acme-demo/knowledge', 'POST', {circuits: [{name: 'bad-schema', text: '@s_bad schema\n  name "bad"\n  predicate ~ana\n'}]});
  assert.equal(bad.status, 422);
  assert.match(JSON.stringify(bad.body), /schema_member_type/);
});

test('the reason and verify slots reach the turn: a named engine answers, verification never or always', async t => {
  const {stubQueryParser} = await import('../helpers.mjs');
  const sop = '@q query\n  select ?who\n  where match\n    relation "works at"\n    role subject ?who\n    role object "Acme"\n    polarity affirmed\n  end\n';
  const s = await productServer(t, {config: {mrp: {defaultModel: 'acme', client: fakeClient()}}, serverOptions: {queryParser: stubQueryParser({sop})}});
  const slots = {normalize: 'passthrough', reflex: 'off', formalize: 'LocalLLMStepByStep', roundtrip: 'off', voice: 'english-only', commit: 'never'};
  assert.equal((await s.user('/v1/mrp/models', 'POST', {id: 'acme', base: 'acme-demo', slots})).status, 201);
  const ask = async (extra, id) => {
    assert.equal((await s.user('/v1/mrp/models/acme', 'PUT', {slots: {...slots, ...extra}})).status, 200);
    const r = await s.user('/v1/chat/completions', 'POST', {model: 'acme', conversation_id: id, messages: [{role: 'user', content: 'Who works at Acme?'}]});
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    return r.body.chatSop;
  };
  const named = await ask({reason: {strategy: 'engine', params: {engine: 'datalog-e10'}}, verify: 'oracle-always'}, 'e1');
  assert.equal(named.status, 'supported', JSON.stringify(named).slice(0, 600));
  assert.equal(named.route?.requested, 'datalog-e10', JSON.stringify(named.route));
  assert.equal(named.route?.verification?.checked, true, 'oracle-always checks the answer');
  // A memory with a value schema (acme-demo) runs on every engine installed everywhere: schema wires are knowledge the engines skip.
  for (const engine of ['sql-sqlite', 'js-reference']) assert.equal((await ask({reason: {strategy: 'engine', params: {engine}}}, 'e-' + engine)).status, 'supported', engine);
  const auto = await ask({reason: 'strategy-router', verify: 'off'}, 'e2');
  assert.equal(auto.route?.requested, 'auto');
  assert.notEqual(auto.route?.verification?.checked, true);
});

test('the strategy service: its self-check makes its strategies available; a discover run lists candidates without writing wires', async t => {
  const {spawn} = await import('node:child_process');
  const port = 19200 + Math.floor(Math.random() * 700);
  const child = spawn('python3', ['-I', 'services/strategy-service/server.py'], {env: {...process.env, MRP_STRATEGY_SERVICE_PORT: String(port)}, stdio: 'ignore'});
  t.after(() => child.kill());
  process.env.MRP_STRATEGY_SERVICE_URL = `http://127.0.0.1:${port}`;
  t.after(() => { delete process.env.MRP_STRATEGY_SERVICE_URL; });
  const {serviceSelfcheck, configureStrategyService} = await import('../../lib/mrp/strategy-service.mjs');
  let check = null;
  for (let i = 0; i < 40 && !check?.ok; i++) { configureStrategyService(null); check = await serviceSelfcheck(); if (!check.ok) await new Promise(r => setTimeout(r, 100)); }
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.strategies['discover/term-stats'].available, true);
  const s = await server(t);
  const cat = await s.user('/v1/mrp/strategies?check=1');
  const discover = cat.body.data.find(x => x.id === 'discover').strategies;
  assert.equal(discover.find(x => x.id === 'term-stats').available, true);
  assert.equal(discover.find(x => x.id === 'sae-pretrained-dictionary').status, 'not-implemented');
  const r = await s.user('/v1/mrp/models/demo-mrp/discover', 'POST', {strategy: 'term-stats', passages: ['Acme ships parts to Cluj. Acme ships boxes.', 'Globex delivers parts; Globex delivers boxes.']});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.candidates.lexemes.some(l => l.term === 'ships'));
  assert.equal(r.body.queued, 0, 'candidates without roles are never queued as wires');
});

test('the scripts of /models compile (the strategy, FAQ and reflex editors live in a template string)', async () => {
  const vm = await import('node:vm');
  const {modelsPage} = await import('../../server/pages/models.mjs');
  const scripts = [...modelsPage({signedIn: true}).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 1);
  // Module scripts: imports are not statements of a classic script, so they are stripped before compiling.
  for (const source of scripts) assert.doesNotThrow(() => new vm.Script(source.replace(/^\s*import\s[^;]*;/gm, '').replace(/^\s*export\s+/gm, '')), source.slice(0, 80));
});

test('verify cross-engine: a second installed engine answers too and the agreement is in the route', async t => {
  const {stubQueryParser} = await import('../helpers.mjs');
  const sop = '@q query\n  select ?who\n  where match\n    relation "works at"\n    role subject ?who\n    role object "Acme"\n    polarity affirmed\n  end\n';
  const s = await productServer(t, {config: {mrp: {defaultModel: 'acme', client: fakeClient()}}, serverOptions: {queryParser: stubQueryParser({sop})}});
  const slots = {normalize: 'passthrough', reflex: 'off', formalize: 'LocalLLMStepByStep', roundtrip: 'off', voice: 'english-only', commit: 'never', reason: {strategy: 'engine', params: {engine: 'sql-sqlite'}}, verify: {strategy: 'cross-engine', params: {engine: 'datalog-e10'}}};
  assert.equal((await s.user('/v1/mrp/models', 'POST', {id: 'acme', base: 'acme-demo', slots})).status, 201);
  const r = await s.user('/v1/chat/completions', 'POST', {model: 'acme', conversation_id: 'x1', messages: [{role: 'user', content: 'Who works at Acme?'}]});
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.chatSop.status, 'supported');
  assert.deepEqual(r.body.chatSop.route.cross_engine, {engine: 'datalog-e10', outcome: 'agreed'});
});

test('cross-engine check in the router: a disagreeing second engine is refereed by the oracle', async () => {
  const {ENGINES} = await import('../../reasoning/router/engines.mjs');
  const {routedAsk} = await import('../../reasoning/router/index.mjs');
  const handle = {kind: 'js-reference-handle', knowledge: '', wires: (await import('../../sop/knowledge/index.mjs')).parse('@p predicate\n  args subject:entity\n@f1 fact\n  holds p a\n').wires};
  const query = '@q query\n  select ?x\n  where p ?x\n';
  const real = ENGINES['datalog-e10'].ask;
  ENGINES['datalog-e10'].ask = (problem, budget) => ({...real(problem, budget), rows: [{x: 'zzz'}]});
  try {
    const kept = routedAsk({handle, query, requested: 'sql-sqlite', crossEngine: 'datalog-e10'});
    assert.equal(kept.route.cross_engine.outcome, 'discrepancy');
    assert.equal(kept.route.cross_engine.oracle, 'first', 'the oracle sides with the first engine, whose answer stays');
    assert.equal(kept.status, 'supported');
  } finally { ENGINES['datalog-e10'].ask = real; }
});
