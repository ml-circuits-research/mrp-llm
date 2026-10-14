import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {productServer} from '../product-helpers.mjs';
import {createMrpRoutes} from '../../server/mrp-routes.mjs';

/** A fake model client for the MRP slots: normalize returns the English message, voice prefixes the answer with "[ro]". */
const fakeClient = () => purpose => ({chat: async ({prompt}) => {
  if (purpose === 'normalize') { const text = prompt.replace(/^MESSAGE:\n/, ''); return {ok: true, text: JSON.stringify({language: /Cine/.test(text) ? 'ro' : 'en', english: /Cine/.test(text) ? 'Does Ana like Alpha Lab?' : text, changed: true})}; }
  if (purpose === 'voice') { const m = /(?:ANSWER|DRAFT REPLY):\n([\s\S]*?)\n\n/.exec(prompt); return {ok: true, text: '[ro] ' + (m?.[1] ?? '')}; }
  return {ok: false, reason: 'not faked'};
}});

const MODEL = {id: 'demo-mrp', name: 'Demo', base: 'default', faq: [{q: 'What are your opening hours?', a: 'From 9 to 17.'}],
  slots: {normalize: 'translate-llm', reflex: 'faq-fixed', roundtrip: 'off', voice: 'translate-only', commit: 'never'}};

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
  assert.deepEqual(r.body.mrp.trace.map(x => x.slot), ['normalize', 'reflex', 'affect', 'roundtrip', 'voice']);
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
