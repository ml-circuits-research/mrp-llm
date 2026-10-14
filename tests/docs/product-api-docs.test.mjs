// The product examples of docs/api.html (sections 10 to 14) are executed in the order of the page against a live test server
// (a stub of the authoring model, no model call): status, documented response keys, and the placeholders <draft-id> and <request-id> filled from
// the earlier answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {productServer, stubAuthorChat} from '../product-helpers.mjs';
import {repoPath} from '../helpers.mjs';

const unescape = s => s.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

test('the product examples of docs/api.html match the live handlers', async t => {
  const html = fs.readFileSync(repoPath('docs/api.html'), 'utf8');
  const examples = [...html.matchAll(/<pre class="api-example product-example" data-endpoint="(\S+) (\S+)" data-request="([^"]*)" data-as="(admin|user)" data-status="(\d+)" data-response-keys="([^"]*)">/g)];
  assert.ok(examples.length >= 16, 'every product endpoint has an executable example');
  const authored = fs.readFileSync(repoPath('tests/fixtures/omp/doc-authored.sop'), 'utf8');
  const s = await productServer(t, {serverOptions: {authorChat: stubAuthorChat({knowledge: authored})}});
  const ctx = {};
  const documented = new Set();
  for (const [, method, rawRoute, encoded, who, status, keys] of examples) {
    const route = unescape(rawRoute);
    documented.add(method + ' ' + route.replace(/\/(family|family-copy|demo-session)(?=\/|$)/g, '/{id}'));
    const body = ['GET', 'DELETE'].includes(method) ? undefined : JSON.parse(unescape(encoded));
    const res = await (who === 'admin' ? s.admin : s.user)(route.replace('{draft}', ctx.draft).replace('{request}', ctx.request).replace('{ingestion}', ctx.ingestion), method, body && Object.keys(body).length ? body : method === 'POST' ? {} : undefined);
    assert.equal(res.status, Number(status), `${method} ${route}: ${res.text.slice(0, 300)}`);
    for (const key of keys.split(',')) assert.ok(key in res.body, `${method} ${route}: documented response key ${key}`);
    if (route === '/v1/author') Object.assign(ctx, {request: res.body.request_id});
    if (/\/ingest$/.test(route)) ctx.ingestion = res.body.id;
  }
  for (const wanted of ['GET /v1/memories', 'POST /v1/memories', 'GET /v1/memories/{id}', 'POST /v1/memories/{id}/fork', 'POST /v1/memories/{id}/knowledge', 'POST /v1/sessions', 'GET /v1/sessions/{id}',
    'POST /v1/sessions/{id}/settings', 'GET /v1/sessions/{id}/theory', 'POST /v1/sessions/{id}/query', 'POST /v1/sessions/{id}/commit',
    'POST /v1/author', 'GET /v1/sessions/{id}/requests/{request}']) {
    assert.ok(documented.has(wanted), wanted + ' has an example');
  }
});

test('docs/api.html lists every product endpoint of the server in its table', async t => {
  const html = fs.readFileSync(repoPath('docs/api.html'), 'utf8');
  const s = await productServer(t);
  const caps = await s.user('/v1/capabilities');
  for (const e of caps.body.endpoints.filter(x => /^\/v1\/(memories|sessions|author)/.test(x.path))) {
    const short = e.path.replace(/\{[a-z]+\}/g, m => m).replace('/v1/sessions/{id}/', '').replace('/v1/memories/{id}/', '');
    assert.ok(html.includes(e.path.split('{')[0].replace(/\/$/, '')) || html.includes(short), `${e.method} ${e.path} appears on the page`);
  }
});
