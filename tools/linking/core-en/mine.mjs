#!/usr/bin/env node
/**
 * Mine the relation vocabulary that core-en must cover (linking proposal, section 5.2).
 *
 * Reads the train and dev rows of datasets/symbolic_english and datasets/neuro_english (gold_sop, else sop), the archive
 * verification world, the smoke cases and the frames TSVs, and writes eval/reports/current/core-en/mined.json: per relation
 * phrase its count, role sets, head word, value kinds and example row ids; per common-noun value its count; the archive and
 * smoke predicates with their surfaces. The miner reads data, never model input, and names no predicate.
 *
 *   node tools/linking/core-en/mine.mjs [--out FILE]
 */
import {readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJsonlShardedSync, jsonlExists} from '../../../lib/jsonl-shards.mjs';
import {phraseKey} from '../../../sop/linking.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COPULA = new Set(['be', 'is', 'are', 'was', 'were', 'been']);
const ARTICLES = new Set(['a', 'an', 'the']);

/** One mention per `relation` line; the `role` lines that follow belong to it. */
export function parseModelSop(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text ?? '').split('\n')) {
    if (/^@/.test(raw)) { cur = null; continue; }
    let m;
    if ((m = /^\s+relation\s+"((?:[^"\\]|\\.)*)"/.exec(raw))) { cur = {relation: JSON.parse('"' + m[1] + '"'), roles: []}; out.push(cur); }
    else if (cur && (m = /^\s+role\s+(\w+)\s+(.*)$/.exec(raw))) cur.roles.push({name: m[1], value: m[2].trim()});
  }
  return out;
}

export function relationRows(root = ROOT) {
  const rows = [];
  for (const dataset of ['symbolic_english', 'neuro_english']) {
    for (const split of ['train', 'dev']) {
      const base = join(root, 'datasets', dataset, split + '.jsonl');
      const records = jsonlExists(base) ? readJsonlShardedSync(base) : [];
      for (const r of records) rows.push({id: r.id, dataset, split, message: r.message, wires: parseModelSop(r.gold_sop ?? r.sop)});
    }
  }
  return rows;
}

function valueKind(v) {
  if (v.startsWith('?')) return 'variable';
  let s; try { s = JSON.parse(v); } catch { return 'other'; }
  if (/^\d[\d .,]*$/.test(s)) return 'number';
  if (/^(the )?user$/i.test(s)) return 'user';
  if (/^(he|she|they|it|him|her|them|i|we|you|his|its|their)$/i.test(s)) return 'pronoun';
  return /^\p{Lu}/u.test(s) && !/^(The|A|An) /.test(s) ? 'proper' : 'common';
}

export function headOf(phrase) {
  const t = phrase.split(/\s+/);
  let i = 0;
  while (i < t.length && (COPULA.has(t[i]) || ARTICLES.has(t[i]))) i++;
  return {copular: COPULA.has(t[0]) && t.length > 1, head: t[i] ?? t[0]};
}

function archiveWorld(root) {
  const file = join(root, 'probably_obsolete/tinyLLMExperiments/datasets_archive/formalizer-v1/world/predicates.sop');
  const out = [];
  let cur = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const h = /^@(\S+)\s+predicate/.exec(raw);
    if (h) { cur = {id: h[1], roles: [], en: [], ro: [], description: ''}; out.push(cur); continue; }
    if (!cur) continue;
    let m;
    if ((m = /^\s+role\s+(\w+)\s+(\w+)/.exec(raw))) cur.roles.push(m[1] + ':' + m[2]);
    else if ((m = /^\s+(?:label|alias)\s+(en|ro)\s+"(.*)"/.exec(raw))) cur[m[1]].push(m[2]);
    else if ((m = /^\s+description\s+"(.*)"/.exec(raw))) cur.description = m[1];
  }
  return out;
}

function smokePredicates(root) {
  const dir = join(root, 'eval/smoke-reasoning/cases');
  const seen = new Map();
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const f = join(dir, name, 'knowledge.sop');
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < text.length; i++) {
      const h = /^@(\S+)\s+predicate/.exec(text[i]);
      if (!h) continue;
      let args = '';
      for (let j = i + 1; j < text.length && text[j].startsWith('  '); j++) { const m = /^\s+args\s+(.*)/.exec(text[j]); if (m) args = m[1]; }
      if (!seen.has(h[1])) seen.set(h[1], {id: h[1], args, cases: []});
      seen.get(h[1]).cases.push(name);
    }
  }
  return [...seen.values()];
}

function framesSurfaces(root) {
  const out = [];
  for (const f of ['frames-world.tsv', 'frames-train.tsv']) {
    const p = join(root, 'config/dictionary', f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('id\t')) continue;
      const c = line.split('\t');
      out.push({file: f, relation: c[1], roles: c[2], surfaces: (c[3] ?? '').split('|').filter(Boolean)});
    }
  }
  return out;
}

export function mine(root = ROOT) {
  const rows = relationRows(root);
  const phrases = new Map(), nouns = new Map();
  let mentions = 0;
  for (const row of rows) for (const w of row.wires) {
    mentions++;
    let p = phrases.get(w.relation);
    if (!p) phrases.set(w.relation, p = {phrase: w.relation, key: phraseKey(w.relation), count: 0, rows: new Set(), roleSets: {}, kinds: {}, examples: [], ...headOf(w.relation)});
    p.count++; p.rows.add(row.id);
    const rs = w.roles.map(r => r.name).sort().join('+');
    p.roleSets[rs] = (p.roleSets[rs] ?? 0) + 1;
    for (const r of w.roles) {
      const k = valueKind(r.value);
      p.kinds[r.name + ':' + k] = (p.kinds[r.name + ':' + k] ?? 0) + 1;
      if (k === 'common') { const s = JSON.parse(r.value).toLowerCase().replace(/^(the|a|an) /, ''); nouns.set(s, (nouns.get(s) ?? 0) + 1); }
    }
    if (p.examples.length < 3) p.examples.push({id: row.id, message: row.message});
  }
  const list = [...phrases.values()].sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase)).map(p => ({...p, rows: p.rows.size}));
  return {
    generated: new Date().toISOString(),
    rows: rows.length, mentions, distinctPhrases: list.length,
    phrases: list,
    commonNouns: [...nouns].sort((a, b) => b[1] - a[1]).slice(0, 600).map(([noun, count]) => ({noun, count})),
    archiveWorld: archiveWorld(root),
    smokePredicates: smokePredicates(root),
    frames: framesSurfaces(root),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : join(ROOT, 'eval/reports/current/core-en/mined.json');
  const r = mine();
  mkdirSync(dirname(out), {recursive: true});
  writeFileSync(out, JSON.stringify(r, null, 1) + '\n');
  console.log(JSON.stringify({out, rows: r.rows, mentions: r.mentions, phrases: r.distinctPhrases, archive: r.archiveWorld.length, smoke: r.smokePredicates.length}));
}
