// lib/cache/lru.mjs (DS009 "Capability APIs and caches"): correctness, eviction, TTL, in-flight de-duplication under concurrency,
// a multi-user parallel run with mixed keys, and failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCache, createCacheSet, cacheKey, canonicalJson, normalizeInput} from '../../lib/cache/lru.mjs';

const tick = (ms = 1) => new Promise(resolve => setTimeout(resolve, ms));

test('the key is stable over object key order and changes with every part', () => {
  assert.equal(cacheKey('understand', 'v1', 'hello', {a: 1, b: 2}), cacheKey('understand', 'v1', 'hello', {b: 2, a: 1}));
  assert.notEqual(cacheKey('understand', 'v1', 'hello', {a: 1}), cacheKey('understand', 'v2', 'hello', {a: 1}), 'a model or run version is part of the key');
  assert.notEqual(cacheKey('understand', 'v1', 'hello', {a: 1}), cacheKey('understand', 'v1', 'hello', {a: 2}), 'options are part of the key');
  assert.notEqual(cacheKey('understand', 'v1', 'hello', {}), cacheKey('analyze', 'v1', 'hello', {}), 'the capability is part of the key');
  assert.equal(canonicalJson({b: undefined, a: [1, {d: 1, c: 2}]}), '{"a":[1,{"c":2,"d":1}]}');
  assert.equal(normalizeInput('  é  '), 'é');
});

test('the same input is a hit and different options are a miss', async () => {
  const cache = createCache({maxEntries: 10});
  let calls = 0;
  const compute = async () => ({n: ++calls});
  const a = await cache.getOrCompute(cacheKey('p', 'v', 'x', {sendAll: false}), compute);
  const b = await cache.getOrCompute(cacheKey('p', 'v', 'x', {sendAll: false}), compute);
  const c = await cache.getOrCompute(cacheKey('p', 'v', 'x', {sendAll: true}), compute);
  assert.deepEqual([a.status, b.status, c.status], ['miss', 'hit', 'miss']);
  assert.equal(b.value.n, 1);
  assert.equal(c.value.n, 2);
  const s = cache.stats();
  assert.deepEqual([s.hits, s.misses, s.entries], [1, 2, 2]);
});

test('LRU eviction by entry count keeps the recently used entry', async () => {
  const cache = createCache({maxEntries: 3});
  for (const k of ['a', 'b', 'c']) cache.set(k, k);
  assert.equal(cache.get('a'), 'a'); // a is now the most recently used
  cache.set('d', 'd');
  assert.equal(cache.has('b'), false, 'b was the least recently used');
  assert.ok(cache.has('a') && cache.has('c') && cache.has('d'));
  assert.equal(cache.stats().evictions, 1);
});

test('eviction by approximate bytes, and a value larger than the bound is not stored', async () => {
  const cache = createCache({maxEntries: 100, maxBytes: 1000});
  for (let i = 0; i < 10; i++) cache.set('k' + i, 'x'.repeat(300));
  assert.ok(cache.stats().bytes <= 1000);
  assert.ok(cache.stats().entries <= 3);
  cache.set('huge', 'y'.repeat(5000));
  assert.equal(cache.has('huge'), false);
  assert.equal(cache.stats().tooBig, 1);
});

test('TTL: an expired entry is a miss and is recomputed', async () => {
  let time = 1000;
  const cache = createCache({ttlMs: 100, now: () => time});
  let calls = 0;
  const run = () => cache.getOrCompute('k', async () => ++calls);
  assert.equal((await run()).status, 'miss');
  time += 99;
  assert.equal((await run()).status, 'hit');
  time += 2;
  const again = await run();
  assert.deepEqual([again.status, again.value], ['miss', 2]);
  assert.equal(cache.stats().expired, 1);
});

test('50 concurrent identical requests run exactly one computation', async () => {
  const cache = createCache();
  let calls = 0;
  const slow = async () => { calls++; await tick(30); return {answer: 42}; };
  const results = await Promise.all(Array.from({length: 50}, () => cache.getOrCompute('same', slow)));
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.value.answer === 42));
  const statuses = results.map(r => r.status);
  assert.equal(statuses.filter(s => s === 'miss').length, 1);
  assert.equal(statuses.filter(s => s === 'shared').length, 49);
  assert.equal(cache.stats().inflight, 0);
  assert.equal((await cache.getOrCompute('same', slow)).status, 'hit');
  assert.equal(calls, 1);
});

test('multi-user parallel run with mixed keys: one computation per distinct key, no cross-talk', async () => {
  const cache = createCache({maxEntries: 500});
  const calls = new Map();
  const compute = key => async () => { calls.set(key, (calls.get(key) ?? 0) + 1); await tick(Math.random() * 10); return 'value-of-' + key; };
  const users = Array.from({length: 20}, (_, u) => u);
  const work = users.flatMap(user => Array.from({length: 30}, (_, i) => {
    const key = 'key-' + ((user * 7 + i * 3) % 12); // 12 distinct keys shared by all users in varying order
    return (async () => { await tick(Math.random() * 5); const r = await cache.getOrCompute(key, compute(key)); assert.equal(r.value, 'value-of-' + key); return r.status; })();
  }));
  const statuses = await Promise.all(work);
  assert.equal(statuses.length, 600);
  assert.equal(calls.size, 12);
  for (const [key, n] of calls) assert.equal(n, 1, key + ' computed once');
  assert.equal(statuses.filter(s => s === 'miss').length, 12);
});

test('a failure is not cached by default and rejects every waiter', async () => {
  const cache = createCache();
  let calls = 0;
  const failing = async () => { calls++; await tick(10); throw Object.assign(new Error('backend down'), {code: 'backend_unavailable'}); };
  const results = await Promise.allSettled(Array.from({length: 5}, () => cache.getOrCompute('f', failing)));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'backend_unavailable'));
  assert.equal(calls, 1, 'the waiters shared the one failing computation');
  assert.equal(cache.has('f'), false);
  const ok = await cache.getOrCompute('f', async () => 'recovered');
  assert.deepEqual([ok.status, ok.value], ['miss', 'recovered']);
});

test('with failureTtlMs a failure is remembered briefly and marked', async () => {
  let time = 0;
  const cache = createCache({failureTtlMs: 50, now: () => time});
  let calls = 0;
  const failing = async () => { calls++; throw new Error('boom'); };
  await assert.rejects(cache.getOrCompute('f', failing), /boom/);
  await assert.rejects(cache.getOrCompute('f', failing), error => error.cachedFailure === true);
  assert.equal(calls, 1);
  assert.equal(cache.stats().failureHits, 1);
  time += 60;
  await assert.rejects(cache.getOrCompute('f', failing), error => !error.cachedFailure);
  assert.equal(calls, 2);
});

test('cacheable() keeps a degraded result out of the cache', async () => {
  const cache = createCache();
  let calls = 0;
  const run = () => cache.getOrCompute('k', async () => ({ok: ++calls > 1}), {cacheable: v => v.ok});
  assert.equal((await run()).value.ok, false);
  assert.equal((await run()).value.ok, true);
  assert.equal((await run()).status, 'hit');
});

test('clone mode hands out independent copies; the cache set reports every cache', async () => {
  const cache = createCache({clone: true});
  const first = (await cache.getOrCompute('k', async () => ({list: [1]}))).value;
  first.list.push(2);
  assert.deepEqual((await cache.getOrCompute('k', async () => null)).value, {list: [1]});
  const set = createCacheSet({maxEntries: 5});
  set.add('one'); set.add('two', {maxEntries: 2});
  assert.deepEqual(Object.keys(set.stats()), ['one', 'two']);
  assert.equal(set.stats().two.maxEntries, 2);
});
