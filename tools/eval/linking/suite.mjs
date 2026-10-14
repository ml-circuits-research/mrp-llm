#!/usr/bin/env node
/**
 * The linking suite (linking proposal sections 6 and 8.2): how well the KnowledgeLinker binds the strings of a SymbolicLM program to
 * the symbols of a base memory. Part 1 has mechanical labels, taken from the verification world a row was generated with (its entity
 * labels and aliases, and the predicate each query proposition was written for); parts 2 and 3 (judge labels) come later.
 *
 *   node tools/eval/linking/suite.mjs build                      writes eval/suites/linking-v1/{test.jsonl,meta.json}
 *   node tools/eval/linking/suite.mjs run [--linker exact|scored-no-head|scored] [--stage 100|300|all] [--out DIR]
 *                                                                writes DIR/baseline-<linker>.json (default eval/reports/current/linking/)
 *
 * Sealed: the suite is evaluation scaffolding. It is built from the sealed tests of symbolic_english and neuro_english and its rows
 * are never training input (eval/leakage.mjs forbids generators and training code from naming a test file). Mention labels exist
 * only where a row's SymbolicLM mention can be aligned with a labelled proposition of its source row; the rest is counted as
 * unlabelled, never guessed. Class linking has no mechanical label and is reported as not measured.
 *
 * Metrics, per labelled mention: correct (bound to the gold symbol), wrong (bound to another symbol: the safety number),
 * unlinked (no binding: the KnowledgeLinker clarified or the row failed) and, per row, full-query agreement with the
 * expected status and answers. The entity tier measured here is the lexicon (exact, then accent-folded, any language); the
 * dictionary tier is part of the relation path only.
 */
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {readJsonlShardedSync, jsonlExists} from '../../../lib/jsonl-shards.mjs';
import {legacyRows, worldOfDatasetRow, runAgainstWorld} from '../../linking/rows.mjs';
import {parseModelSop} from '../../linking/core-en/mine.mjs';
import {Lexicon} from '../../../sop/lexicon.mjs';
import {fold} from '../../../sop/text-keys.mjs';
import {phraseKey} from '../../../sop/linking.mjs';
import {configureLinker} from '../../../sop/knowledge-linker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SUITE_DIR = path.join(ROOT, 'eval', 'suites', 'linking-v1');
const SOURCES = ['symbolic_english', 'neuro_english'];
const args = Object.fromEntries(process.argv.slice(3).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));

/** A converse realization of a predicate (`manages__converse`) is the same predicate with the roles swapped. */
const predicateOf = id => String(id).replace(/__converse$/, '');
const unq = v => { try { return typeof JSON.parse(v) === 'string' ? JSON.parse(v) : null; } catch { return null; } };
const key = s => fold(String(s)).replace(/^(?:the|a|an)\s+/, '');
const roleKey = roles => roles.map(r => key(r)).sort().join('|');

/** Entity gold: the folded label or alias of an entity of the source row's world -> its id (ambiguous strings are dropped). */
function entityGold(legacy) {
  const map = new Map(), dropped = new Set();
  for (const e of legacy.verification_context?.entities ?? []) for (const s of [e.label, ...(e.aliases ?? [])].filter(Boolean)) {
    const k = key(s);
    if (map.has(k) && map.get(k) !== e.id) dropped.add(k);
    map.set(k, e.id);
  }
  for (const k of dropped) map.delete(k);
  return map;
}

/**
 * Labelled propositions of the source row: (relation phrase, role strings) -> the predicate it was written for, and the role strings
 * alone when they name one predicate only (two propositions over the same strings with different predicates are not aligned by strings).
 */
function propositionGold(legacy) {
  const ir = legacy.surface_ir ?? {}, exact = new Map(), loose = new Map();
  const add = p => {
    const strings = (p.roles ?? []).map(([, v]) => unq(v)).filter(v => v !== null);
    if (!strings.length || !p.link?.predicate) return;
    exact.set(phraseKey(p.relation ?? '') + '#' + roleKey(strings), p.link.predicate);
    const k = roleKey(strings), seen = loose.get(k);
    loose.set(k, seen === undefined || seen === p.link.predicate ? p.link.predicate : null);
  };
  for (const p of [...(ir.stated ?? []), ...(ir.assumed ?? [])]) add(p);
  for (const p of ir.query?.props ?? []) add(p);
  return {find: (relation, strings) => exact.get(phraseKey(relation) + '#' + roleKey(strings)) ?? loose.get(roleKey(strings)) ?? null};
}

/** The suite rows: one per sealed test row whose source row carries a verification world. */
export function buildRows() {
  const legacy = legacyRows(), rows = [];
  for (const dataset of SOURCES) {
    const file = path.join(ROOT, 'eval', 'suites', dataset, 'test.jsonl');
    if (!jsonlExists(file)) continue;
    for (const row of readJsonlShardedSync(file)) {
      const source = legacy.get(row.source?.id);
      const sop = row.gold_sop ?? row.sop;
      if (!source || !sop || row.sop_valid === false) continue;
      const entities = entityGold(source), props = propositionGold(source);
      const mentions = [];
      for (const wire of parseModelSop(sop)) {
        const strings = wire.roles.map(r => unq(r.value)).filter(v => v !== null);
        const gold = props.find(wire.relation, strings);
        mentions.push({kind: 'relation', phrase: wire.relation, strings, gold});
        for (const s of strings) { const id = entities.get(key(s)); if (id) mentions.push({kind: 'entity', surface: s, gold: id}); }
      }
      if (!mentions.some(m => m.gold)) continue;
      rows.push({
        id: `linking-v1::${row.id}`, dataset, row_id: row.id, legacy_id: source.id, message: row.message, sop, language: source.language ?? 'en',
        mentions, expected: source.expected ?? null, family: row.source?.family ?? source.family ?? null,
      });
    }
  }
  return rows;
}

function build() {
  const rows = buildRows();
  fs.mkdirSync(SUITE_DIR, {recursive: true});
  fs.writeFileSync(path.join(SUITE_DIR, 'test.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const count = kind => rows.reduce((n, r) => n + r.mentions.filter(m => m.kind === kind && m.gold).length, 0);
  const meta = {
    suite: 'linking-v1', part: 1, labels: 'mechanical (verification world of the source row)', sealed: true, built_at: new Date().toISOString(),
    sources: SOURCES.map(s => `eval/suites/${s}/test.jsonl`), rows: rows.length,
    labelled: {relation_mentions: count('relation'), entity_mentions: count('entity')},
    unlabelled_relation_mentions: rows.reduce((n, r) => n + r.mentions.filter(m => m.kind === 'relation' && !m.gold).length, 0),
    not_measured: ['class linking (no mechanical label)', 'justified versus unjustified clarification (needs judge labels, part 2)'],
  };
  fs.writeFileSync(path.join(SUITE_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(JSON.stringify(meta));
}

export function wilson(k, n, z = 1.96) {
  if (!n) return {k, n, rate: null, lo: null, hi: null};
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return {k, n, rate: +p.toFixed(4), lo: +((c - m) / d).toFixed(4), hi: +((c + m) / d).toFixed(4)};
}

const sample = (rows, n) => {
  if (!n || n >= rows.length) return rows;
  let state = 1234567;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const list = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list.slice(0, n);
};

async function run() {
  const linker = args.linker ?? 'scored';
  const ARMS = {exact: {scored: false, headVerb: false}, 'scored-no-head': {scored: true, headVerb: false}, scored: {scored: true, headVerb: true}};
  if (!ARMS[linker]) throw Error(`unknown linker ${linker}: exact (the M1 linker), scored-no-head or scored`);
  configureLinker(ARMS[linker]);
  const file = path.join(SUITE_DIR, 'test.jsonl');
  if (!jsonlExists(file)) throw Error('suite missing: run `node tools/eval/linking/suite.mjs build` first');
  const all = readJsonlShardedSync(file);
  const stage = args.stage ?? 'all';
  const rows = sample(all, stage === 'all' ? null : Number(stage));
  const t = {relation: {k: 0, wrong: 0, unlinked: 0, n: 0}, entity: {k: 0, wrong: 0, unlinked: 0, n: 0}, query: {k: 0, n: 0}, clarified_rows: 0, error_rows: 0};
  const latencies = [], wrongs = [], worlds = {'row-world': 0, 'predicates-only': 0};
  const lexicons = new Map();
  for (const row of rows) {
    const world = worldOfDatasetRow({source: {id: row.legacy_id}});
    worlds[world.source]++;
    let lexicon = lexicons.get(world.ontology);
    if (!lexicon) { lexicon = new Lexicon(world.ontology); if (lexicons.size > 200) lexicons.clear(); lexicons.set(world.ontology, lexicon); }
    const started = performance.now();
    const out = await runAgainstWorld({sop: row.sop, message: row.message, world, language: row.language, lexicon});
    latencies.push(performance.now() - started);
    if (out.status === 'error') t.error_rows++;
    if (out.status === 'clarify') t.clarified_rows++;
    const linking = out.result?.result?.packet?.linking ?? [];
    for (const m of row.mentions) {
      if (!m.gold) continue;
      if (m.kind === 'relation') {
        const hits = linking.filter(e => e.kind === 'relation' && phraseKey(e.surface) === phraseKey(m.phrase));
        t.relation.n++;
        if (hits.some(e => predicateOf(e.symbol) === predicateOf(m.gold))) t.relation.k++;
        else if (hits.length) { t.relation.wrong++; wrongs.push({row: row.id, kind: 'relation', surface: m.phrase, gold: m.gold, got: hits.map(e => e.symbol)}); }
        else t.relation.unlinked++;
      } else {
        const found = lexicon.matching(m.surface, {language: 'auto', kind: 'entity'}).found;
        t.entity.n++;
        if (found.length === 1 && found[0].id === m.gold) t.entity.k++;
        else if (found.length === 1) { t.entity.wrong++; wrongs.push({row: row.id, kind: 'entity', surface: m.surface, gold: m.gold, got: [found[0].id]}); }
        else t.entity.unlinked++;
      }
    }
    if (row.expected?.status) {
      t.query.n++;
      const wanted = (row.expected.answers ?? []).map(a => JSON.stringify(a)).sort();
      if (out.status === row.expected.status && (!row.expected.answers || JSON.stringify(out.answers) === JSON.stringify(wanted))) t.query.k++;
    }
  }
  latencies.sort((a, b) => a - b);
  const pct = q => +latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]?.toFixed(1);
  const part = x => ({...wilson(x.k, x.n), wrong: wilson(x.wrong, x.n), unlinked: wilson(x.unlinked, x.n)});
  const report = {
    linker, suite: 'linking-v1 part 1 (mechanical labels)', stage, rows: rows.length, suite_rows: all.length, worlds,
    relation_linking: part(t.relation), entity_linking: part(t.entity),
    full_query: wilson(t.query.k, t.query.n),
    clarified_rows: wilson(t.clarified_rows, rows.length), error_rows: wilson(t.error_rows, rows.length),
    wrong_link_rate: wilson(t.relation.wrong + t.entity.wrong, t.relation.n + t.entity.n),
    latency_ms_per_row: {p50: pct(0.5), p95: pct(0.95), mean: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1)},
    not_measured: ['class linking (no mechanical label)', 'justified versus unjustified clarification (judge labels, part 2)'],
    notes: ['Labels are mechanical and the worlds are the ones the rows were generated with, so this is a regression and floor check of the current linker, not a measure of linking in an open vocabulary.', 'A wrong link can also be label noise: two propositions over the same strings written for different predicates.'],
    wrong_examples: wrongs.slice(0, 25), generated: new Date().toISOString(),
  };
  const out = path.resolve(ROOT, args.out ?? 'eval/reports/current/linking');
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, `baseline-${linker}${stage === 'all' ? '' : '-' + stage}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({rows: report.rows, relation: report.relation_linking.rate, entity: report.entity_linking.rate, full_query: report.full_query.rate, wrong: report.wrong_link_rate.rate, latency: report.latency_ms_per_row}));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'build') build();
  else if (cmd === 'run') await run();
  else { console.error('usage: linking-suite.mjs build | run [--linker exact|scored-no-head|scored] [--stage 100|300|all] [--out DIR]'); process.exit(2); }
}
