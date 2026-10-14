import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {Repository} from '../../memory/repository.mjs';
import {demoLexicon} from '../../lib/knowledge-seeds.mjs';
import {createServer} from '../../server/http.mjs';
import {close, listen, repoPath, repoUrl, tempDir, withEnv, assertReply} from '../helpers.mjs';
import {stubQueryParser} from '../product-helpers.mjs';

const tokens = {alice: 'alice-secret-token-123456', bob: 'bob-secret-token-123456'};
// The default mock reply: a context-free model-language question (DS014).
const likes = (subject, object) => `@q query\n  where match\n    relation "likes"\n    role subject "${subject}"\n    role object "${object}"\n    polarity affirmed\n  end`;
const query = likes('Ana', 'Alpha Lab');

/**
 * One ChatSOP server whose request parser is a stub of the coding agent (server/query-parser.mjs interface). `replies` maps the user message
 * to the SOP the stub returns (default: `query`); `calls` records what the parser received (`{messages: [{role, content}]}`).
 */
async function fixture(t, {replies = {}, lexicon, limits = {}, config = {}, memory, onCall = () => {}} = {}) {
  const root = tempDir(t, 'chatsop-http-');
  const repo = new Repository(root, memory ? {memory} : undefined);
  repo.init('base');
  const lex = lexicon ?? demoLexicon();
  const calls = [];
  const parser = stubQueryParser();
  parser.parse = async ({message}) => {
    calls.push({messages: [{role: 'user', content: message}]});
    await onCall({message});
    return {sop: replies[message] ?? query, parse: {parser: 'coding_agent', model: 'stub/model', backend: 'stub', rounds: 1, cost_usd: 0, ms: 1, cache: 'miss', tried: []}};
  };
  const endpoint = 'http://stub.invalid';
  const options = {repo, lexicon: lex, base: 'base', authTokens: tokens, limits, config: {policy: {allowWrite: true}, ...config}, queryParser: parser};
  let server = createServer(options);
  let url = await listen(t, server);
  async function restart() {
    await close(server);
    server = createServer({...options, repo: new Repository(root, memory ? {memory} : undefined), sessionRoot: path.join(root, 'http-conversations')});
    url = await listen(t, server);
  }
  async function request(method, route, body, token = tokens.alice) {
    const headers = {...(token ? {Authorization: 'Bearer ' + token} : {}), ...(body ? {'Content-Type': 'application/json'} : {})};
    const response = await fetch(url + route, {method, headers, body: body ? JSON.stringify(body) : undefined});
    const raw = await response.text();
    const streamed = response.headers.get('content-type')?.includes('text/event-stream');
    return {status: response.status, body: raw && !streamed ? JSON.parse(raw) : null, raw, headers: response.headers};
  }
  async function chat(text, {conversation_id = 'c1', token = tokens.alice, ...extra} = {}) {
    return request('POST', '/v1/chat/completions', {model: 'chatsop-local', messages: [{role: 'user', content: text}], conversation_id, ...extra}, token);
  }
  return {root, repo, lex, endpoint, calls, request, chat, restart, get url() { return url; }};
}
const record = atom => `@f fact\n  holds ${atom}\n  valid timeless\n  source user\n@s remember\n  input $f`;
const readyz = async url => fetch(url + '/readyz', {headers: {Authorization: 'Bearer ' + tokens.alice}});

test('authenticated model discovery, readiness and streaming expose one verified trace', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/healthz')).status, 200);
  const ready = (await f.request('GET', '/readyz')).body;
  assert.deepEqual([ready.ready, ready.model_available, ready.default_model], [true, true, 'chatsop-local']);
  assert.equal((await f.request('GET', '/v1/models')).body.data[0].id, 'chatsop-local', 'the façade model is listed with the coding agent state');
  const reply = await f.chat('Ana likes Alpha Lab?', {stream: true});
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get('content-type'), /text\/event-stream/);
  assert.match(reply.raw, /data: \[DONE\]/);
  const event = JSON.parse(reply.raw.split('\n')[0].slice(6));
  assert.equal(event.chatSop.status, 'unknown');
  assert.equal(event.chatSop.prompt_profile, undefined, 'there are no prompt profiles');
  assert.equal(event.chatSop.formalizer_model, 'formalizer:stub/model');
  assert.equal(event.chatSop.backend, 'js');
  assert.equal(event.chatSop.completeness, true);
  assert.equal(event.chatSop.fallback, null);
  assert.match(event.chatSop.circuit, /@\w+ solve/);
  assert.equal(f.calls[0].messages[0].content, 'Ana likes Alpha Lab?', 'the circuit author receives the message and nothing else');
});

test('an explicit external backend is never substituted: the HTTP trace names it and reports no fallback', async t => {
  // With SWI deliberately unavailable, the prolog-tabling strategy answers `unsupported` naming the backend (AGENTS.md rule 8).
  const f = await fixture(t, {config: {policy: {allowWrite: true, reasoningStrategy: 'prolog-tabling'}}});
  const reply = await withEnv('SWIPL_BIN', path.join(f.root, 'missing-swipl'), () => f.chat('Ana likes Alpha Lab?'));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.chatSop.backend, 'prolog');
  assert.equal(reply.body.chatSop.fallback, null);
  assert.notEqual(reply.body.chatSop.status, 'supported', 'no JS answer stands in for the missing backend');
});

test('remember, correction, contradiction, UNKNOWN, restart and principal isolation', async t => {
  const f = await fixture(t);
  const first = await f.chat('Ana likes Alpha Lab?', {chatSop: {trustedSop: record('likes ana lab_alpha')}});
  assert.equal(first.status, 200);
  assert.equal(first.body.chatSop.status, 'supported');
  assert.match(first.body.chatSop.system_circuit, /@s remember/);
  const id = first.body.chatSop.system_receipt.ids[0];
  assert.ok(id);
  assert.equal((await f.chat('Ana likes Alpha Lab?')).body.chatSop.status, 'supported');
  assert.equal((await f.chat('Ana likes Alpha Lab?', {token: tokens.bob})).body.chatSop.status, 'unknown');
  const correction = `@f fact\n  holds likes ana lab_beta\n  valid timeless\n  source user\n@e event\n  action correct\n  target "${id}"\n  replacement $f\n@s remember\n  input $e`;
  const corrected = await f.chat('Ana likes Alpha Lab?', {chatSop: {trustedSop: correction}});
  assert.equal(corrected.body.chatSop.status, 'unknown');
  assert.equal(corrected.body.chatSop.system_receipt.count, 2);
  const contradiction = record('likes ana lab_alpha').replace('source user', 'source corrected_user')
    + '\n@n fact\n  holds not likes ana lab_alpha\n  valid timeless\n  source user\n@sn remember\n  input $n';
  const conflict = await f.chat('Ana likes Alpha Lab?', {chatSop: {trustedSop: contradiction}});
  assert.equal(conflict.body.chatSop.status, 'both');
  assert.ok(conflict.body.chatSop.provenance.length);
  await f.restart();
  assert.equal((await f.chat('Ana likes Alpha Lab?')).body.chatSop.status, 'both');
  assert.equal((await f.chat('Ana likes Alpha Lab?', {token: tokens.bob})).body.chatSop.status, 'unknown');
  assert.ok(f.calls.length >= 2, 'the service is asked again after the restart (its cache is per server)');
});

test('user suppositions stay conditional and caller-owned; a restart never turns them into facts', async t => {
  const supposed = '@p stated\n  relation "likes"\n  role subject "Ana"\n  role object "Alpha Lab"\n  polarity affirmed\n  certainty supposed\n' + query;
  const f = await fixture(t, {replies: {'Assume Ana likes Alpha Lab. Does she?': supposed}});
  const assumed = await f.chat('Assume Ana likes Alpha Lab. Does she?');
  assert.equal(assumed.status, 200);
  assert.equal(assumed.body.chatSop.status, 'supported');
  assert.deepEqual(assumed.body.chatSop.user_statements.map(item => [item.atom, item.certainty, item.treatment]), [['likes ana lab_alpha', 'supposed', 'supposition']]);
  assert.match(assumed.body.chatSop.cnl, /This result depends on the stated assumptions/);
  // The supposition is not a sourced fact: no session claim was recorded.
  assert.equal(Object.keys(f.repo.session('base', 'alice', 'c1').live.claims).length, 0);
  await f.restart();
  // Another conversation of the same user, after the restart, sees no fact.
  const fresh = await f.chat('Ana likes Alpha Lab?', {conversation_id: 'c2'});
  assert.equal(fresh.body.chatSop.status, 'unknown');
  assert.deepEqual(fresh.body.chatSop.user_statements, []);
  // A supposition is not carried: the same conversation asks again without it.
  const again = await f.chat('Ana likes Alpha Lab?');
  assert.equal(again.body.chatSop.status, 'unknown');
  // The repository reopened from disk holds no claim for the supposition either.
  const reopened = new Repository(f.root);
  for (const conversation of ['c1', 'c2']) {
    assert.equal(Object.keys(reopened.session('base', 'alice', conversation).live.claims).length, 0, conversation);
  }
});

test('answers are English, the language field is gone, and the model-language trace holds statements and assumptions', async t => {
  const unclear = '@u unclear\n  kind gibberish';
  const stated = '@s stated\n  relation "likes"\n  role subject "Ana"\n  role object "Alpha Lab"\n  polarity affirmed\n  certainty asserted\n@a assumed\n  relation "likes"\n  role subject "Ana"\n  role object "Beta Lab"\n  polarity negated\n  basis closure\n' + query;
  const f = await fixture(t, {replies: {'asdf qwer': unclear, 'Ana likes Alpha Lab. Does she like Beta Lab too?': stated}});
  const english = await f.chat('asdf qwer');
  assert.equal(english.status, 200);
  await assertReply(english.body.choices[0].message.content, 'gibberish');
  assert.deepEqual([english.body.chatSop.status, english.body.chatSop.unclear], ['unclear', 'gibberish']);
  assert.equal((await f.chat('asdf qwer', {language: 'ro'})).status, 400, 'the language field is gone: answers are English');
  const answer = await f.chat('Ana likes Alpha Lab. Does she like Beta Lab too?');
  assert.equal(answer.body.chatSop.status, 'supported');
  assert.deepEqual(answer.body.chatSop.user_statements.map(s => [s.atom, s.treatment]), [['likes ana lab_alpha', 'evidence']]);
  assert.deepEqual(answer.body.chatSop.model_assumptions.map(a => [a.predicate, a.polarity, a.basis, a.treatment]), [['likes', 'negated', 'closure', 'reported']]);
  assert.equal(answer.body.chatSop.assumption_policy, 'report');
  assert.equal(answer.body.chatSop.assumption_branch, null);
});

test('a proof-use promotion is reported in the HTTP trace, and a read-only policy performs none', async t => {
  const memory = {power: 16, arity: 3, retention: {reinforceOnUse: true, writeStrength: 1, useStrength: 2}};
  const promoting = await fixture(t, {memory});
  const stored = await promoting.chat('Ana likes Alpha Lab?', {chatSop: {trustedSop: record('likes ana lab_alpha')}});
  assert.equal(stored.body.chatSop.status, 'supported');
  assert.deepEqual(stored.body.chatSop.reinforcement, {facts: 1, strength: 2});
  const readOnly = await fixture(t, {memory, config: {policy: {allowWrite: true, reinforce: false}}});
  const read = await readOnly.chat('Ana likes Alpha Lab?', {chatSop: {trustedSop: record('likes ana lab_alpha')}});
  assert.equal(read.body.chatSop.status, 'supported');
  assert.equal(read.body.chatSop.reinforcement, null);
});

test('fail closed, bearer security, request limits, unsupported surfaces and model privilege refusal', async t => {
  const f = await fixture(t, {limits: {maxRequestBytes: 1600, maxContextBytes: 180}});
  assert.equal((await f.request('GET', '/v1/models', null, null)).status, 401);
  assert.equal((await f.request('GET', '/readyz', null, 'wrong-secret-token-123456')).status, 401);
  assert.equal((await f.chat('x'.repeat(181))).status, 413);
  assert.equal((await f.chat('short', {padding: 'x'.repeat(1600)})).status, 413);
  assert.equal((await f.chat('Ana likes Alpha Lab?', {user: 'bob'})).status, 400);
  for (const route of ['/v1/responses', '/v1/embeddings', '/v1/tools']) assert.equal((await f.request('POST', route, {})).status, 501);
  assert.equal((await f.chat('x', {tools: []})).status, 400);
  const injected = await fixture(t, {replies: {'Record this': '@f fact\n  holds likes ana lab_alpha\n  valid timeless\n@s remember\n  input $f'}});
  const refused = await injected.chat('Record this');
  assert.equal(refused.status, 422, 'a circuit with runtime plumbing is refused, and shown as the rejected SOP');
  assert.equal(refused.body.error.code, 'model_output_rejected');
  assert.match(refused.body.chatSop.rejection, /declarative/);
  assert.equal(Object.keys(injected.repo.session('base', 'alice', 'c1').live.claims).length, 0);
  const offline = createServer({config: {}, repo: f.repo, lexicon: f.lex, base: 'base', authTokens: tokens, queryParser: stubQueryParser({available: false})});
  const offlineUrl = await listen(t, offline);
  const response = await readyz(offlineUrl);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).model_available, false);
  const down = await fetch(offlineUrl + '/v1/chat/completions', {method: 'POST', headers: {Authorization: 'Bearer ' + tokens.alice, 'Content-Type': 'application/json'}, body: JSON.stringify({model: 'chatsop-local', messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}]})});
  assert.equal(down.status, 503);
  assert.equal((await down.json()).error.code, 'parse_unavailable');
});

test('same-session serialization, global concurrency and time limits refuse overload', async t => {
  let entered, enteredOther, release;
  const arrived = new Promise(resolve => entered = resolve);
  const arrivedOther = new Promise(resolve => enteredOther = resolve);
  const held = new Promise(resolve => release = resolve);
  let count = 0;
  const f = await fixture(t, {limits: {maxConcurrent: 2}, onCall: async () => { (count++ ? enteredOther : entered)(); await held; }});
  const first = f.chat('Ana likes Alpha Lab?');
  await arrived;
  assert.equal((await f.chat('Ana likes Alpha Lab?')).status, 409);
  // Different messages: the request parser may cache an identical message and reach the coding agent once.
  const other = f.chat('Does Ana like Alpha Lab?', {conversation_id: 'other'});
  await arrivedOther;
  assert.equal((await f.chat('Is Ana fond of Alpha Lab?', {conversation_id: 'third'})).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await other).status, 200);
  const timed = await fixture(t, {limits: {timeoutMs: 20}, onCall: () => new Promise(resolve => setTimeout(resolve, 100))});
  const response = await timed.chat('Ana likes Alpha Lab?');
  assert.equal(response.status, 504);
  assert.doesNotMatch(response.raw, /Ana|token|127\\.0\\.0\\.1/);
});

test('the circuit author receives the message alone; there is no prompt profile and no chat mode', async t => {
  const f = await fixture(t);
  const answer = await f.chat('Ana likes Alpha Lab?');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.chatSop.prompt_profile, undefined);
  assert.equal(f.calls[0].messages[0].content, 'Ana likes Alpha Lab?', 'the author receives the message alone');
  assert.deepEqual(Object.keys(f.calls[0].messages[0]).sort(), ['content', 'role']);
  assert.equal((await f.chat('Ana likes Alpha Lab?', {mode: 'chat'})).status, 400, 'the mode field is not accepted');
  assert.equal((await f.chat('Ana likes Alpha Lab?', {parser: 'local'})).status, 400, 'there is no parser choice');
});

test('documentation site is served statically without authentication and cannot be escaped', async t => {
  const f = await fixture(t, {});
  const raw = await fetch(f.url + '/docs/index.html');
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /text\/html/);
  assert.equal(await raw.text(), fs.readFileSync(repoUrl('docs/index.html'), 'utf8'));
  const redirect = await fetch(f.url + '/docs', {redirect: 'manual'});
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/docs/');
  // The home page is public: it links the browser pages and reports readiness,
  // but never shows an internal endpoint to an unauthenticated visitor.
  const home = await fetch(f.url + '/', {redirect: 'manual'});
  assert.equal(home.status, 200);
  const homeText = await home.text();
  for (const link of ['href="/chat"', 'href="/experiments"', 'href="/admin"', 'href="/docs/"']) assert.ok(homeText.includes(link), link);
  assert.match(homeText, /Formalizer \(LocalLLMStepByStep\): <b class="ok">ready/, "the home page reports the formalizer");
  assert.match(homeText, /bearer tokens only/);
  assert.ok(!homeText.includes(f.endpoint), 'the mock endpoint is not disclosed to anonymous visitors');
  // Without a password store there is no browser login: /chat stays a 401 API answer.
  const anonymousChat = await fetch(f.url + '/chat', {headers: {Accept: 'text/html'}, redirect: 'manual'});
  assert.equal(anonymousChat.status, 401);
  assert.equal((await anonymousChat.json()).error.code, 'unauthorized');
  const bearerChat = await fetch(f.url + '/chat', {headers: {Authorization: 'Bearer ' + tokens.alice}});
  assert.equal(bearerChat.status, 200);
  assert.match(await bearerChat.text(), /\/v1\/chat\/completions/);
  const spec = await fetch(f.url + '/docs/specs/matrix.md');
  assert.equal(spec.status, 200);
  assert.match(spec.headers.get('content-type'), /text\/markdown/);
  const style = await fetch(f.url + '/docs/styles.css');
  assert.equal(style.status, 200);
  assert.match(style.headers.get('content-type'), /text\/css/);
  const missing = await fetch(f.url + '/docs/does-not-exist.html');
  assert.equal(missing.status, 404);
  // Traversal attempts must never escape docs/; the encoded form reaches the handler.
  const rawPath = route => new Promise(resolve => {
    const request = http.request({host: '127.0.0.1', port: Number(new URL(f.url).port), path: route, method: 'GET'}, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.end();
  });
  assert.equal(await rawPath('/docs/%2e%2e/AGENTS.md'), 400);
  assert.equal(await rawPath('/docs/..%2fAGENTS.md'), 400);
  assert.equal(await rawPath('/docs/%00.txt'), 400);
  // The chat API still requires its bearer token.
  const chat = await f.request('POST', '/v1/chat/completions', {model: 'chatsop-local', messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}]}, null);
  assert.equal(chat.status, 401);
});
