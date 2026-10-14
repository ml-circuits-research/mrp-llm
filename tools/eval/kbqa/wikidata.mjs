/**
 * The KBQA evaluation's Wikidata access: the polite WDQS client of tools/world-kb/wdqs.mjs with its own cache
 * (datasets_sources/kbqa/raw/, gitignored) and User-Agent "ChatSOP-kbqa". One request at a time, a 1.2 s gap, retries with back-off.
 */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createSparqlClient} from '../../world-kb/wdqs.mjs';
import {CACHE} from './benchmarks.mjs';

export const RAW = path.join(CACHE, 'raw');
export const sparql = createSparqlClient({raw: RAW, userAgent: 'ChatSOP-kbqa/0.1 (https://github.com/axiologic; research@axiologic.net) node-fetch', gapMs: 1200});
export const hash = text => createHash('sha1').update(text).digest('hex').slice(0, 12);
export const qidOf = uri => (typeof uri === 'string' && uri.startsWith('http://www.wikidata.org/entity/') ? uri.slice(31) : null);
export const values = ids => ids.map(id => `wd:${id}`).join(' ');
