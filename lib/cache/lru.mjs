/**
 * A small bounded cache for the expensive, deterministic capability calls (DS009 "Capability APIs and caches").
 *
 *   const cache = createCache({name: 'proofread-llm', maxEntries: 400, maxBytes: 4_000_000, ttlMs: 600_000});
 *   const {value, status} = await cache.getOrCompute(cacheKey('proofread', version, sentence, options), () => callModel(sentence));
 *
 * - LRU eviction by entry count and by approximate bytes (JSON length of the value, UTF-16 length x 2 is not needed: JSON.stringify
 *   length is a stable, cheap approximation).
 * - TTL per entry; an expired entry is a miss and is removed.
 * - In-flight de-duplication: concurrent identical requests share ONE computation (a promise map); the followers report `shared`.
 * - A failed computation is never cached as a value. With `failureTtlMs > 0` the failure is remembered briefly and marked
 *   (`negative: true` in stats, status `failure_hit`), so a broken backend is not hammered; the default is 0 (not cached).
 * - Results are returned as stored (callers treat them as read-only); `clone: true` returns a structuredClone instead.
 * - Safe for parallel use inside one Node process: all state changes are synchronous between awaits.
 *
 * `cacheKey(...parts)` is the stable key: a SHA-256 of the canonical JSON (sorted object keys) of the parts, so the capability,
 * the model or run version, the normalized input and the options all take part and a model switch never serves a stale result.
 */
import {createHash} from 'node:crypto';

/** Canonical JSON: object keys sorted, undefined dropped. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export const cacheKey = (...parts) => createHash('sha256').update(canonicalJson(parts)).digest('hex');

/** Normalizes user text for keys: Unicode NFC and trimmed outer whitespace; inner text is kept exactly (a different spelling is a different input). */
export const normalizeInput = text => String(text ?? '').normalize('NFC').trim();

const sizeOf = value => { try { return (JSON.stringify(value) ?? '').length + 64; } catch { return 1024; } };

export function createCache({name = 'cache', maxEntries = 256, maxBytes = 8_000_000, ttlMs = 10 * 60_000, failureTtlMs = 0, clone = false, now = () => Date.now()} = {}) {
  if (!(maxEntries >= 1)) throw Error('createCache: maxEntries must be at least 1');
  const entries = new Map(); // key -> {value, bytes, expires, failure}; Map order is the LRU order (oldest first)
  const inflight = new Map(); // key -> promise
  const stats = {hits: 0, misses: 0, shared: 0, evictions: 0, expired: 0, failures: 0, failureHits: 0, stored: 0, tooBig: 0};
  let bytes = 0;

  const drop = key => { const e = entries.get(key); if (e) { bytes -= e.bytes; entries.delete(key); } };
  const evict = () => {
    while (entries.size > maxEntries || (bytes > maxBytes && entries.size > 1)) {
      const oldest = entries.keys().next().value;
      drop(oldest);
      stats.evictions++;
    }
  };
  const live = key => {
    const e = entries.get(key);
    if (!e) return null;
    if (e.expires <= now()) { drop(key); stats.expired++; return null; }
    entries.delete(key); entries.set(key, e); // most recently used goes last
    return e;
  };
  const store = (key, value, {failure = false, ttl = ttlMs} = {}) => {
    const size = sizeOf(value);
    if (size > maxBytes) { stats.tooBig++; return; }
    drop(key);
    entries.set(key, {value: clone && !failure ? structuredClone(value) : value, bytes: size, expires: now() + ttl, failure});
    bytes += size;
    stats.stored++;
    evict();
  };
  const out = value => clone ? structuredClone(value) : value;

  return {
    name,
    /** The cached value or undefined (counts as hit or miss). */
    get(key) { const e = live(key); if (!e || e.failure) { stats.misses++; return undefined; } stats.hits++; return out(e.value); },
    has(key) { const e = entries.get(key); return Boolean(e) && e.expires > now() && !e.failure; },
    set(key, value, options) { store(key, value, options); },
    delete(key) { drop(key); },
    clear() { entries.clear(); inflight.clear(); bytes = 0; },
    /**
     * `{value, status}` with status `hit` (stored), `shared` (joined an in-flight computation) or `miss` (this call computed it).
     * `compute` may return `{value, cacheable: false}`-style results only through `options.cacheable(value)`: a function that says whether the
     * fresh value may be stored (default: always). A thrown error rejects every waiter and is not stored (unless `failureTtlMs`).
     */
    async getOrCompute(key, compute, {cacheable = () => true, ttl = ttlMs} = {}) {
      const e = live(key);
      if (e) {
        if (e.failure) { stats.failureHits++; throw Object.assign(new Error(e.value.message), {code: e.value.code, status: e.value.status, cachedFailure: true}); }
        stats.hits++;
        return {value: out(e.value), status: 'hit'};
      }
      const pending = inflight.get(key);
      if (pending) { stats.shared++; return {value: out(await pending), status: 'shared'}; }
      stats.misses++;
      const promise = (async () => {
        try {
          const value = await compute();
          if (cacheable(value)) store(key, value, {ttl});
          return value;
        } catch (error) {
          stats.failures++;
          if (failureTtlMs > 0) store(key, {message: String(error.message).slice(0, 300), code: error.code, status: error.status}, {failure: true, ttl: failureTtlMs});
          throw error;
        } finally { inflight.delete(key); }
      })();
      inflight.set(key, promise);
      promise.catch(() => {}); // the caller below handles the rejection; this avoids an unhandled one when nobody joins
      return {value: out(await promise), status: 'miss'};
    },
    stats() {
      const asked = stats.hits + stats.shared + stats.misses;
      return {name, entries: entries.size, bytes, maxEntries, maxBytes, ttlMs, failureTtlMs, inflight: inflight.size, ...stats, hitRate: asked ? Math.round(((stats.hits + stats.shared) / asked) * 1000) / 1000 : null};
    },
  };
}

/** The named caches of one server, with one place to read every cache's statistics. */
export function createCacheSet(defaults = {}, now) {
  const caches = new Map();
  return {
    add(name, options = {}) { const cache = createCache({...defaults, ...options, name, ...(now ? {now} : {})}); caches.set(name, cache); return cache; },
    get: name => caches.get(name),
    stats: () => Object.fromEntries([...caches].map(([name, cache]) => [name, cache.stats()])),
    clear() { for (const cache of caches.values()) cache.clear(); },
  };
}
