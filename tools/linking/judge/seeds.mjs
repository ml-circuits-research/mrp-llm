#!/usr/bin/env node
/**
 * Seeds of the open-vocabulary linking questions (linking proposal 6.1, parts 2 and 3): facts of the base memory world-v1 sampled per
 * predicate, so that an authoring judge can write natural questions whose answer is the fact. A seed is never model input and never a
 * label by itself: the questions are written freely, and the labels come from independent judges (tools/linking/judge/run.mjs).
 *
 *   node tools/linking/judge/seeds.mjs [--per 10] [--out DIR]     writes DIR/seeds.json (default eval/reports/current/linking/judge)
 *
 * Deterministic: a fixed-seed shuffle over the facts of each predicate whose subject has a notability of at least the median.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatData, chatDataSettings} from '../../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../../lib/chat-data/memories.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const per = Number(opt('--per', 10));
const out = path.resolve(ROOT, opt('--out', 'eval/reports/current/linking/judge'));
const SKIP = new Set(['is_a', 'gender', 'birthday', 'deathday', 'iso_country_code', 'iso_language_code', 'iso_currency_code']);

const lexicon = new BaseMemories({chatData: new ChatData(chatDataSettings({}))}).lexicon('world-v1');
const label = id => lexicon.entities[id]?.labels?.en ?? null;
const byPredicate = new Map();
const dir = path.join(ROOT, 'datasets_sources/world-kb/circuits');
for (const file of fs.readdirSync(dir)) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const m of text.matchAll(/^  holds (\w+) (\S+) (.+)$/gm)) {
    if (SKIP.has(m[1])) continue;
    (byPredicate.get(m[1]) ?? byPredicate.set(m[1], []).get(m[1])).push([m[2], m[3].trim()]);
  }
}
let state = 20261001;
const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
const seeds = [];
for (const [predicate, facts] of [...byPredicate].sort((a, b) => a[0].localeCompare(b[0]))) {
  const known = facts.filter(([s]) => label(s));
  const notab = id => lexicon.entities[id]?.notability ?? 0;
  const sorted = [...known].sort((a, b) => notab(b[0]) - notab(a[0]));
  const pool = sorted.slice(0, Math.max(per * 3, Math.ceil(sorted.length / 2)));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const p = lexicon.predicates[predicate];
  for (const [s, o] of pool.slice(0, per)) {
    const object = /^"/.test(o) ? JSON.parse(o) : (label(o) ?? o);
    seeds.push({predicate, roles: p?.roles?.map(r => r.name) ?? [], subject: {id: s, label: label(s)}, object: {raw: o, label: object}});
  }
}
fs.mkdirSync(out, {recursive: true});
fs.writeFileSync(path.join(out, 'seeds.json'), JSON.stringify(seeds, null, 1) + '\n');
console.log(JSON.stringify({seeds: seeds.length, predicates: new Set(seeds.map(s => s.predicate)).size}));
