import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {adminServer, cookieOf} from '../helpers.mjs';

const PASSWORD = 'correct horse battery';
const login = (call, password) => call('/admin/login', {method: 'POST', body: {password}});

test('first run asks for an administrator password in the browser and blocks the API until it is set', async t => {
  const {call, chat} = await adminServer(t);
  const before = await call('/admin/status');
  assert.equal(before.status, 200);
  assert.equal(before.body.configured, false);
  assert.equal(before.body.authenticated, false);
  const page = await call('/admin');
  assert.equal(page.status, 200);
  assert.match(page.text, /set the administrator password/i);
  const blocked = await chat();
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'setup_required');
  const short = await call('/admin/setup', {method: 'POST', body: {password: 'short'}});
  assert.equal(short.status, 400);
  assert.match(short.body.error.message, /at least \d+ characters/);
  const setup = await call('/admin/setup', {method: 'POST', body: {password: PASSWORD}});
  assert.equal(setup.status, 200);
  const session = cookieOf(setup);
  assert.match(session, /^chatsop_session=/);
  // The chosen password now authenticates the chat API (503 = model missing, not 401/403).
  const chatWithSession = await chat({cookie: session});
  assert.equal(chatWithSession.status, 503);
  const again = await call('/admin/setup', {method: 'POST', body: {password: 'another password'}});
  assert.equal(again.status, 400);
  assert.match(again.body.error.message, /already set/i);
});

test('login, session and logout', async t => {
  const {call} = await adminServer(t, {password: PASSWORD});
  const wrong = await login(call, 'nope-nope-nope');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'invalid_credentials');
  const ok = await login(call, PASSWORD);
  assert.equal(ok.status, 200);
  const session = cookieOf(ok);
  const status = await call('/admin/status', {cookie: session});
  assert.equal(status.body.authenticated, true);
  assert.ok(Array.isArray(status.body.tokens));
  const logout = await call('/admin/logout', {method: 'POST', cookie: session});
  assert.equal(logout.status, 200);
  const after = await call('/admin/status', {cookie: session});
  assert.equal(after.body.authenticated, false, 'a logged-out session must not authenticate');
});

// server/auth.mjs keeps failed attempts for 60 s and refuses a login once ten
// failures are on record; a successful login clears the record.
test('login throttling: ten failures are evaluated, the eleventh attempt is refused even with the right password', async t => {
  const {call} = await adminServer(t, {password: PASSWORD});
  for (let attempt = 1; attempt <= 9; attempt += 1) assert.equal((await login(call, 'wrong-' + attempt)).status, 401, `failure ${attempt}`);
  assert.equal((await login(call, PASSWORD)).status, 200, 'after nine failures the correct password still succeeds and clears the record');
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await login(call, 'wrong-again-' + attempt);
    assert.equal(response.status, 401, `failure ${attempt} is still checked`);
    assert.equal(response.body.error.code, 'invalid_credentials');
  }
  for (const password of ['wrong-eleventh', PASSWORD]) {
    const throttled = await login(call, password);
    assert.equal(throttled.status, 400, password);
    assert.equal(throttled.body.error.code, 'too_many_attempts');
    assert.match(throttled.body.error.message, /too many failed attempts/i);
  }
});

test('API tokens minted from the admin page work as bearer credentials and can be revoked', async t => {
  const {call, chat, auth, root, session} = await adminServer(t, {password: PASSWORD});
  const minted = await call('/admin/token', {method: 'POST', cookie: session, body: {label: 'cli'}});
  assert.equal(minted.status, 200);
  assert.match(minted.body.token, /^[A-Za-z0-9_-]{20,}$/);
  const withToken = await chat({bearer: minted.body.token});
  assert.equal(withToken.status, 503, 'a valid token reaches the model-readiness check');
  const listing = await call('/admin/status', {cookie: session});
  assert.equal(listing.body.tokens.length, 1);
  assert.equal(listing.body.tokens[0].label, 'cli');
  const revoke = await call('/admin/token/revoke', {method: 'POST', cookie: session, body: {id: listing.body.tokens[0].id}});
  assert.equal(revoke.body.revoked, 1);
  const after = await chat({bearer: minted.body.token});
  assert.equal(after.status, 401);
  // The password is stored hashed, never in plaintext, in a 0600 file.
  const stored = fs.readFileSync(path.join(root, 'state/auth.json'), 'utf8');
  assert.doesNotMatch(stored, new RegExp(PASSWORD));
  assert.match(stored, /"salt"/);
  assert.equal(fs.statSync(path.join(root, 'state/auth.json')).mode & 0o777, 0o600);
  assert.equal(auth.verifyPassword(PASSWORD), true);
});

test('CHATSOP_API_KEY keeps working as an environment-provided bearer token without any setup', async t => {
  const {call, chat} = await adminServer(t, {apiKey: 'environment-token-123456'});
  const status = await call('/admin/status');
  assert.equal(status.body.configured, false, 'no password set yet');
  const withKey = await chat({bearer: 'environment-token-123456'});
  assert.equal(withKey.status, 503, 'the environment token authenticates without a password');
  const wrong = await chat({bearer: 'environment-token-000000'});
  assert.equal(wrong.status, 401);
});

// Browser pages: one /login flow on top of the same session cookie. A browser
// page load (Accept: text/html) is redirected to the login page; API calls keep
// their JSON 401/403 answers.
const page = (base, route, {cookie, accept = 'text/html', method = 'GET', form, origin, authorization} = {}) => {
  const headers = {Accept: accept};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (authorization) headers.Authorization = authorization;
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return fetch(base + route, {method, headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual'});
};

test('signed-out browser page loads redirect to /login while API calls keep JSON 401/403', async t => {
  const {base, call} = await adminServer(t, {password: PASSWORD});
  for (const route of ['/chat', '/experiments', '/admin']) {
    const response = await page(base, route);
    assert.equal(response.status, 303, route);
    assert.equal(response.headers.get('location'), '/login?next=' + encodeURIComponent(route), route);
  }
  const withQuery = await page(base, '/chat?x=1');
  assert.equal(withQuery.headers.get('location'), '/login?next=' + encodeURIComponent('/chat?x=1'));
  // API clients (no HTML Accept, or API paths) are never redirected.
  assert.equal((await call('/chat')).status, 401);
  assert.equal((await call('/experiments')).status, 401);
  for (const route of ['/experiments/api/status', '/v1/models', '/readyz']) {
    const response = await page(base, route);
    assert.equal(response.status, 401, route);
    assert.equal((await response.json()).error.code, 'unauthorized', route);
  }
  const post = await fetch(base + '/v1/chat/completions', {method: 'POST', headers: {Accept: 'text/html', 'Content-Type': 'application/json'}, body: '{}', redirect: 'manual'});
  assert.equal(post.status, 401);
  // A request that carries a (wrong) bearer header is an API call, not a page load.
  assert.equal((await page(base, '/chat', {authorization: 'Bearer wrong-token-0000000000'})).status, 401);
  // Before any password exists the API answers setup_required, pages still redirect.
  const fresh = await adminServer(t);
  assert.equal((await page(fresh.base, '/chat')).status, 303);
  assert.equal((await fresh.chat()).body.error.code, 'setup_required');
});

test('the login flow only redirects to same-origin relative paths', async t => {
  const {base} = await adminServer(t, {password: PASSWORD});
  const {safeNext} = await import('../../server/pages/login.mjs');
  for (const unsafe of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'chat', '/chat\r\nSet-Cookie: x=y', '', null, '/' + 'a'.repeat(600)]) assert.equal(safeNext(unsafe), '/', String(unsafe));
  assert.equal(safeNext('/chat?conversation=a#b'), '/chat?conversation=a#b');
  assert.equal(safeNext('/audit'), '/audit');
  const form = await (await page(base, '/login?next=' + encodeURIComponent('//evil.example/'))).text();
  assert.match(form, /name="next" value="\/"/);
  for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
    const response = await page(base, '/login', {method: 'POST', form: {password: PASSWORD, next}});
    assert.equal(response.status, 303, next);
    assert.equal(response.headers.get('location'), '/', next);
  }
  // A cross-site form post is refused before the password is even checked.
  const crossSite = await page(base, '/login', {method: 'POST', form: {password: PASSWORD, next: '/chat'}, origin: 'http://evil.example'});
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get('set-cookie'), null);
});

test('home page reports sign-in state, password setup and formalizer readiness', async t => {
  const fresh = await adminServer(t);
  const first = await (await page(fresh.base, '/')).text();
  assert.match(first, /No administrator password yet/);
  assert.match(first, /Administrator password: <span class="bad">not set/);
  assert.match(first, /Formalizer \(LocalLLMStepByStep\): <b class="bad">not available/);
  assert.match(first, /HTTP 503/);
  for (const link of ['href="/chat"', 'href="/experiments"', 'href="/admin"', 'href="/docs/"']) assert.ok(first.includes(link), link);
  
  const {base, session} = await adminServer(t, {password: PASSWORD});
  const signedOut = await (await page(base, '/')).text();
  assert.match(signedOut, /Not signed in/);
  assert.match(signedOut, /Administrator password: <span class="ok">set/);
  const signedIn = await (await page(base, '/', {cookie: session})).text();
  assert.match(signedIn, /Signed in/);
  assert.match(signedIn, /parse_unavailable/, 'the signed-in home page says what happens without a formalizer');
  assert.match(signedIn, /action="\/logout"/);
});

test('first run: choose the password on /login, land on the chat, log out and sign in again', async t => {
  const {base, chat} = await adminServer(t);
  const choose = await (await page(base, '/login?next=%2Fchat')).text();
  assert.match(choose, /Choose the administrator password/);
  const mismatch = await page(base, '/login', {method: 'POST', form: {password: PASSWORD, confirm: 'different password', next: '/chat'}});
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /do not match/);
  const short = await page(base, '/login', {method: 'POST', form: {password: 'short', confirm: 'short', next: '/chat'}});
  assert.equal(short.status, 400);
  assert.match(await short.text(), /too short: use at least 8 characters/);
  const setup = await page(base, '/login', {method: 'POST', form: {password: PASSWORD, confirm: PASSWORD, next: '/chat'}});
  assert.equal(setup.status, 303);
  assert.equal(setup.headers.get('location'), '/chat');
  const session = cookieOf(setup);
  assert.match(session, /^chatsop_session=.+/);
  const chatPage = await page(base, '/chat', {cookie: session});
  assert.equal(chatPage.status, 200);
  const html = await chatPage.text();
  assert.match(html, /New conversation/);
  assert.match(html, /\/v1\/chat\/completions/);
  assert.match(html, /action="\/logout"/);
  assert.equal((await chat({cookie: session})).status, 503, 'the cookie authenticates the chat API (model unavailable, not 401)');
  const admin = await page(base, '/admin', {cookie: session});
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /API tokens/);
  // A second setup attempt through the form cannot replace the password.
  const replay = await page(base, '/login', {method: 'POST', form: {mode: 'setup', password: 'another password', confirm: 'another password'}});
  assert.equal(replay.status, 409);
  const logout = await page(base, '/logout', {method: 'POST', cookie: session});
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), '/login');
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await page(base, '/chat', {cookie: session})).status, 303, 'the old session no longer opens the chat');
  assert.match(await (await page(base, '/login?next=%2Faudit')).text(), /Sign in/);
  const wrong = await page(base, '/login', {method: 'POST', form: {password: 'wrong password', next: '/audit'}});
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Wrong password/);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const ok = await page(base, '/login', {method: 'POST', form: {password: PASSWORD, next: '/audit'}});
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/audit');
  // Signed in, /login forwards straight to the requested page.
  const again = await page(base, '/login?next=%2Fchat', {cookie: cookieOf(ok)});
  assert.equal(again.headers.get('location'), '/chat');
});

test('the login form reports throttling in plain words', async t => {
  const {base} = await adminServer(t, {password: PASSWORD});
  for (let attempt = 1; attempt <= 10; attempt += 1) assert.equal((await page(base, '/login', {method: 'POST', form: {password: 'wrong-' + attempt}})).status, 401);
  const throttled = await page(base, '/login', {method: 'POST', form: {password: PASSWORD}});
  assert.equal(throttled.status, 429);
  assert.match(await throttled.text(), /Too many failed attempts/);
  assert.equal(throttled.headers.get('set-cookie'), null);
});
