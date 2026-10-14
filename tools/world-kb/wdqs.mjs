/**
 * Polite Wikidata Query Service client for the world-v1 base memory (tools/world-kb/).
 * One request at a time, a descriptive User-Agent, a minimum gap between requests, retries with back-off on 429/5xx/timeouts,
 * and a raw-response cache under datasets_sources/world-kb/raw/ (gitignored) so a repeated run costs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW = path.join(ROOT, 'datasets_sources', 'world-kb', 'raw');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'ChatSOP-worldkb/0.1 (https://github.com/axiologic; research@axiologic.net) node-fetch';
const GAP_MS = 2500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A polite WDQS client: `raw` is its cache folder, `userAgent` its descriptive User-Agent, `gapMs` the minimum gap between two requests
 * of this client. Used by world-v1 (the default client below) and by the KBQA evaluation (tools/eval/kbqa/, its own cache and User-Agent).
 * `sparql(name, query)` runs a SELECT (or ASK: the boolean comes back as `[{boolean: 'true'|'false'}]`) and caches it as `<raw>/<name>.json`.
 */
export function createSparqlClient({raw = RAW, userAgent = UA, gapMs = GAP_MS} = {}) {
  let last = 0;
  return async function sparql(name, query, {timeoutMs = 90000, retries = 4} = {}) {
    fs.mkdirSync(raw, {recursive: true});
    const file = path.join(raw, `${name}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).rows;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {'User-Agent': userAgent, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded'},
          body: new URLSearchParams({query}).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          const retry = Number(res.headers.get('retry-after')) || 15 * (attempt + 1);
          console.error(`[wdqs] ${name}: HTTP ${res.status}, waiting ${retry}s`);
          await sleep(retry * 1000);
          last = Date.now();
          continue;
        }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`), {permanent: res.status === 400});
        const json = await res.json();
        const rows = typeof json.boolean === 'boolean' ? [{boolean: String(json.boolean)}]
          : json.results.bindings.map(b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
        fs.writeFileSync(file, JSON.stringify({name, fetched_at: new Date().toISOString(), query, rows}));
        return rows;
      } catch (error) {
        console.error(`[wdqs] ${name}: ${error.message} (attempt ${attempt + 1})`);
        if (error.permanent) break;
        await sleep(10000 * (attempt + 1));
        last = Date.now();
      }
    }
    throw new Error(`wdqs: ${name} failed`);
  };
}

/** Runs a SPARQL SELECT and returns the bindings flattened to plain strings; `name` names the cache file (world-v1 client). */
export const sparql = createSparqlClient();
export const qid = uri => uri?.replace('http://www.wikidata.org/entity/', '');
