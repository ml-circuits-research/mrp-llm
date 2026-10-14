#!/usr/bin/env node
/**
 * Fetch English and Romanian labels, aliases and descriptions of a curated list of Wikidata properties (CC0, DS011) into
 * the local source cache datasets_sources/core-en/wikidata-properties.json. Polite: one request per 50 ids with a project
 * User-Agent and a pause. The cache is input to the core-en authoring batches; nothing here is model input.
 */
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PROPERTIES = `P31 P279 P361 P527 P131 P17 P30 P36 P1376 P47 P150 P276 P159 P740 P937 P551 P19 P20 P27 P569 P570 P22 P25 P40 P3373 P26 P1038 P1290
P108 P463 P102 P39 P488 P169 P1037 P127 P1830 P749 P355 P112 P571 P576 P69 P1066 P802 P184 P185 P54 P286 P413 P118 P641 P106 P101
P50 P57 P58 P161 P175 P86 P170 P178 P123 P407 P364 P495 P577 P580 P582 P585 P793 P1344 P710 P664 P1001 P137 P176 P121 P366 P1535 P2283
P1346 P166 P1411 P6 P35 P37 P38 P1082 P2046 P2044 P2048 P2067 P2043 P1448 P1449 P2561 P1476 P1813 P856 P281 P6375 P669 P1050 P2176 P780
P1995 P769 P2175 P2789 P197 P81 P451 P3342 P2868 P1552 P1269 P1889 P460 P138 P61 P575 P800 P2670 P518 P1056 P1454 P452 P2139 P1128 P1114
P2130 P2284 P2555 P1619 P8324 P859 P3320 P2828 P5052 P1308 P1196 P509 P119 P1412 P103 P172 P140 P21 P735 P734 P742 P1559 P1477 P3095
P2094 P1327 P647 P2517 P2438 P1830 P1431 P162 P2515 P2554 P744 P1344 P3450 P1001 P2632 P2632 P1435 P1881 P2341 P1191 P2429 P8032`.split(/\s+/).filter((p, i, a) => /^P\d+$/.test(p) && a.indexOf(p) === i);

const sleep = ms => new Promise(r => setTimeout(r, ms));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = {};
  for (let i = 0; i < PROPERTIES.length; i += 50) {
    const ids = PROPERTIES.slice(i, i + 50).join('|');
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=labels|aliases|descriptions&languages=en|ro&format=json`;
    const res = await fetch(url, {headers: {'User-Agent': 'ChatSOP-core-en/1.0 (research@axiologic.net; vocabulary mining, CC0 data)'}});
    const json = await res.json();
    for (const [pid, e] of Object.entries(json.entities ?? {})) {
      if (e.missing !== undefined) continue;
      out[pid] = {
        label: {en: e.labels?.en?.value ?? null, ro: e.labels?.ro?.value ?? null},
        aliases: {en: (e.aliases?.en ?? []).map(a => a.value), ro: (e.aliases?.ro ?? []).map(a => a.value)},
        description: {en: e.descriptions?.en?.value ?? null}
      };
    }
    await sleep(2500);
  }
  mkdirSync(join(ROOT, 'datasets_sources/core-en'), {recursive: true});
  writeFileSync(join(ROOT, 'datasets_sources/core-en/wikidata-properties.json'), JSON.stringify({retrieved: new Date().toISOString(), licence: 'CC0 (Wikidata:Licensing)', properties: out}, null, 1) + '\n');
  console.log('properties', Object.keys(out).length);
}
