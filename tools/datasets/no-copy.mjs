#!/usr/bin/env node
/** No-copy check: proves that corpus text is not copied from the cached public sources (DS011, owner decision
 * of 2026-09-28).
 *
 *   node tools/datasets/no-copy.mjs --corpus formalizer-v1 [--out <report.json>]
 *   node tools/datasets/no-copy.mjs --files a.jsonl,b.jsonl --name formalizer-v1-eval [--out <report.json>]
 *
 * `--corpus` reads the development splits `datasets/<corpus>/{train,dev}.jsonl`; any other file (for example a
 * sealed export) is passed explicitly with `--files`, so this module never hard-codes a sealed path. Builders
 * call `checkNoCopy(rows)` in memory on every split before they write.
 *
 * Measures, per row, over its natural-language text (question, attached assertions, background text, entity
 * labels, predicate glosses):
 *   - paired 4-grams: word 4-grams shared with the specific source row named in its lineage; stock phrases
 *     (found in >= STOCK_PHRASE_DF source rows, e.g. "what is the name") are reported apart (bar: 0 distinctive);
 *   - long spans: word 8-grams shared with any cached source text (bar: 0);
 *   - global 4-gram rate: share of the row's 4-grams found anywhere in the sources (reported, not failed:
 *     common English phrasing is legitimately shared);
 *   - identifier leakage: case ids, source row ids, generator counters or hash-like names in text (bar: 0).
 * Exit status 1 when a bar is exceeded, 2 when the check cannot run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { jsonlExists, readJsonlSharded } from '../../lib/jsonl-shards.mjs';
import { fileURLToPath } from 'node:url';
import {corpusDir} from '../../lib/dataset-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourcesDir = path.join(root, 'datasets_sources');

export const tokens = text => String(text ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** 52-bit numeric key of an n-gram: two independent 32-bit FNV-1a hashes combined. */
function key(words) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const c = word.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
    a = Math.imul(a ^ 32, 0x01000193) >>> 0;
    b = Math.imul(b ^ 32, 0x5bd1e995) >>> 0;
  }
  return a * 0x100000 + (b & 0xfffff);
}
export function ngrams(words, n) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(key(words.slice(i, i + n)));
  return out;
}

/** Natural-language text of a row: everything a reader or the model sees as language. */
export function rowText(row) {
  const context = row.verification_context ?? row.context ?? {};
  return [
    row.question ?? row.message, ...(row.context_assertions ?? []), ...(context.background_assertions ?? []),
    ...(context.background_rules ?? []).filter(rule => typeof rule === 'string' && !/\?\w/.test(rule)),
    ...(context.entities ?? []).map(entity => entity.label), ...(context.predicates ?? []).map(p => p.gloss ?? p.meaning ?? p.description),
  ].filter(value => typeof value === 'string' && value.length).join('\n');
}

/** The source row a corpus row names in its lineage, as `source:rowKey`, or null. */
export function lineageKey(row) {
  const lineage = row.lineage ?? row.generation_trace?.lineage ?? null;
  if (!lineage?.source || lineage.source_row_id === undefined || lineage.source_row_id === null) return null;
  const source = String(lineage.source).toLowerCase();
  let id = String(lineage.source_row_id);
  if (source === 'qa2d') id = id.split(':').at(-1);
  return `${source}:${id}`;
}

/** A 4-gram found in at least this many distinct source rows is a stock phrase, not a copied span. */
export const STOCK_PHRASE_DF = 20;

const ID_PATTERNS = [
  [/\b[a-z]{1,6}[_-](?:qqp|paws|qa2d|ambignq|proofwriter)[_-]\d+/i, 'source_case_id'],
  [/\b[a-z]+_\d+(?:_\d+)+\b/, 'generator_counter'],
  [/\b\p{Lu}\p{Ll}{2,}\d+\p{L}*\b/u, 'hash_like_name'],
];
/** Identifier leakage findings for one row. */
export function identifierFindings(row) {
  const text = [row.question ?? row.message, ...(row.context_assertions ?? [])].filter(Boolean).join('\n');
  const findings = [];
  const ids = [row.id, row.split_group_id, row.semantic_case_id].filter(value => typeof value === 'string' && value.length >= 4);
  for (const id of new Set(ids)) for (const form of new Set([id, id.replaceAll('_', '-'), id.replaceAll('_', ' ')]))
    if (text.includes(form)) findings.push({ kind: 'case_id', value: form });
  const lineage = row.lineage ?? row.generation_trace?.lineage;
  const sourceId = lineage?.source_row_id !== undefined && lineage?.source_row_id !== null ? String(lineage.source_row_id).split(':').at(-1) : null;
  if (sourceId && sourceId.length >= 4 && new RegExp(`(^|[^\\p{L}\\p{N}])${sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(text))
    findings.push({ kind: 'source_row_id', value: sourceId });
  for (const [pattern, kind] of ID_PATTERNS) {
    const match = text.match(pattern);
    if (match) findings.push({ kind, value: match[0] });
  }
  return findings;
}

/** Every cached source text, streamed as {source, key, text}. Keys match `lineageKey`. */
async function* sourceTexts(dir = sourcesDir) {
  const lines = async function* (file) {
    if (jsonlExists(file)) yield* readJsonlSharded(file);
  };
  for (const split of ['train', 'validation']) for await (const row of lines(path.join(dir, 'qqp', `${split}.jsonl`)))
    yield { source: 'qqp', key: `qqp:${row.idx}`, text: [row.question1, row.question2] };
  for (const split of ['train', 'validation']) for await (const row of lines(path.join(dir, 'paws', `${split}.jsonl`)))
    yield { source: 'paws', key: `paws:${row.id}`, text: [row.sentence1, row.sentence2] };
  for (const split of ['train', 'dev']) for await (const row of lines(path.join(dir, 'qa2d', `${split}.jsonl`)))
    yield { source: 'qa2d', key: `qa2d:${row.example_uid}`, text: [row.question, row.answer, row.turker_answer, row['rule-based']] };
  for (const split of ['train', 'validation', 'test']) for await (const row of lines(path.join(dir, 'proofwriter-structured', `OWA-${split}.jsonl`)))
    yield { source: 'proofwriter', key: `proofwriter:${row.id}`, text: [row.theory_text, ...(row.questions ?? []).map(q => q.text)] };
  for (const split of ['train', 'dev']) {
    const file = path.join(dir, 'ambignq', `${split}.json`);
    if (!fs.existsSync(file)) continue;
    for (const row of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      const texts = [row.question];
      for (const annotation of row.annotations ?? []) {
        for (const pair of annotation.qaPairs ?? []) texts.push(pair.question, ...(pair.answer ?? []));
        texts.push(...(annotation.answer ?? []));
      }
      yield { source: 'ambignq', key: `ambignq:${row.id}`, text: texts };
    }
  }
  const squad = path.join(dir, 'squad2-dev', 'raw', 'dev-v2.0.json');
  if (fs.existsSync(squad)) for (const article of JSON.parse(fs.readFileSync(squad, 'utf8')).data)
    for (const paragraph of article.paragraphs) yield { source: 'squad', key: `squad:${article.title}`, text: [paragraph.context, ...paragraph.qas.map(q => q.question)] };
}

/**
 * Check rows in memory. Returns a report object; `report.pass` is false when a bar is exceeded.
 * `rows` may be an array or an async iterable of {row, split}.
 */
export async function checkNoCopy(rows, { name = 'rows', examples = 10, dir = sourcesDir } = {}) {
  const started = performance.now();
  const items = [];
  const four = new Map(), eight = new Map();
  const needed = new Map();
  for await (const entry of rows) {
    const row = entry.row ?? entry;
    const words = tokens(rowText(row));
    const item = { id: row.id, split: entry.split ?? row.split, words, phrases: [], stock: [], pairedGrams: [], distinctiveHits: 0, four: ngrams(words, 4), eight: ngrams(words, 8), lineage: lineageKey(row), ids: identifierFindings(row), globalHits: 0, eightHits: 0, pairedHits: 0 };
    items.push(item);
    for (const gram of item.four) four.set(gram, (four.get(gram) ?? 0) + 1);
    for (const gram of item.eight) {
      if (!eight.has(gram)) eight.set(gram, []);
      eight.get(gram).push(item);
    }
    if (item.lineage) {
      if (!needed.has(item.lineage)) needed.set(item.lineage, []);
      needed.get(item.lineage).push(item);
    }
  }
  const seenFour = new Set(), sharedEight = new Set();
  const documentFrequency = new Map();
  const sourceRows = {};
  let pairedFound = 0;
  for await (const source of sourceTexts(dir)) {
    sourceRows[source.source] = (sourceRows[source.source] ?? 0) + 1;
    const words = source.text.filter(Boolean).map(text => tokens(text));
    const rowGrams = new Set();
    for (const sentence of words) {
      for (let i = 0; i + 4 <= sentence.length; i++) {
        const gram = key(sentence.slice(i, i + 4));
        if (four.has(gram)) { seenFour.add(gram); rowGrams.add(gram); }
      }
      for (let i = 0; i + 8 <= sentence.length; i++) {
        const gram = key(sentence.slice(i, i + 8));
        if (eight.has(gram)) sharedEight.add(gram);
      }
    }
    for (const gram of rowGrams) documentFrequency.set(gram, (documentFrequency.get(gram) ?? 0) + 1);
    const paired = needed.get(source.key);
    if (paired) {
      pairedFound += paired.length;
      for (const item of paired) for (let i = 0; i + 4 <= item.words.length; i++) {
        const gram = key(item.words.slice(i, i + 4));
        if (rowGrams.has(gram)) item.pairedGrams.push([gram, item.words.slice(i, i + 4).join(' ')]);
      }
    }
  }
  for (const item of items) {
    for (const gram of item.four) if (seenFour.has(gram)) item.globalHits++;
    for (const gram of item.eight) if (sharedEight.has(gram)) item.eightHits++;
    for (const [gram, phrase] of item.pairedGrams) {
      item.pairedHits++;
      if ((documentFrequency.get(gram) ?? 0) < STOCK_PHRASE_DF) { item.distinctiveHits++; if (item.phrases.length < 5) item.phrases.push(phrase); }
      else if (item.stock.length < 5) item.stock.push(phrase);
    }
  }
  const withLineage = items.filter(item => item.lineage);
  const rate = (count, total) => total ? Number((count / total).toFixed(6)) : 0;
  const totalFour = items.reduce((n, item) => n + item.four.size, 0);
  const pick = (filter, map) => items.filter(filter).slice(0, examples).map(map);
  const idKinds = {};
  for (const item of items) for (const finding of item.ids) idKinds[finding.kind] = (idKinds[finding.kind] ?? 0) + 1;
  const report = {
    format: 'chatsop-no-copy-v1', corpus: name, generated_at: new Date().toISOString(),
    rows: items.length, by_split: items.reduce((tally, item) => ({ ...tally, [item.split ?? 'none']: (tally[item.split ?? 'none'] ?? 0) + 1 }), {}),
    source_texts_scanned: sourceRows,
    paired: { rows_with_lineage: withLineage.length, lineage_matches_in_sources: pairedFound, stock_phrase_df: STOCK_PHRASE_DF,
      shared_4grams_total: withLineage.reduce((n, item) => n + item.pairedHits, 0),
      distinctive_shared_4grams: withLineage.reduce((n, item) => n + item.distinctiveHits, 0),
      rows_with_distinctive_shared_4gram: withLineage.filter(item => item.distinctiveHits > 0).length,
      rows_with_stock_phrase_only: withLineage.filter(item => item.pairedHits > 0 && item.distinctiveHits === 0).length,
      note: 'A shared 4-gram is a stock phrase when it occurs in at least stock_phrase_df source rows (for example "what is the name"); only distinctive shared 4-grams count against the bar.',
      examples: pick(item => item.pairedHits > 0, item => ({ id: item.id, source: item.lineage, distinctive: item.phrases, stock_phrases: item.stock })) },
    long_span: { n: 8, rows_with_shared_8gram: items.filter(item => item.eightHits > 0).length, shared_8grams_distinct: sharedEight.size,
      examples: pick(item => item.eightHits > 0, item => ({ id: item.id, shared_8grams: item.eightHits })) },
    global_4gram: { corpus_4grams_distinct: four.size, distinct_found_in_sources: seenFour.size, distinct_rate: rate(seenFour.size, four.size),
      row_4gram_occurrence_rate: rate(items.reduce((n, item) => n + item.globalHits, 0), totalFour), note: 'Reported, not failed: common phrasing is legitimately shared.' },
    identifiers: { rows_with_identifier: items.filter(item => item.ids.length).length, by_kind: idKinds,
      examples: pick(item => item.ids.length > 0, item => ({ id: item.id, findings: item.ids })) },
    elapsed_ms: Math.round(performance.now() - started),
  };
  report.bars = { paired_distinctive_shared_4grams: 0, rows_with_shared_8gram: 0, rows_with_identifier: 0 };
  report.pass = report.paired.distinctive_shared_4grams === 0 && report.long_span.rows_with_shared_8gram === 0 && report.identifiers.rows_with_identifier === 0;
  return report;
}

async function* streamFiles(files) {
  for (const file of files) {
    for await (const row of readJsonlSharded(file)) yield { row, split: row.split ?? path.basename(file, '.jsonl') };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
  const corpus = value('corpus');
  const files = value('files') ? value('files').split(',').map(file => path.resolve(file))
    : corpus ? ['train', 'dev'].map(split => path.join(root, corpusDir(corpus, root), `${split}.jsonl`)) : [];
  const name = value('name') ?? corpus;
  if (!files.length || !name || files.some(file => !jsonlExists(file))) {
    console.error('Use --corpus <name> or --files a.jsonl,b.jsonl --name <name>; every file must exist.');
    process.exit(2);
  }
  try {
    const report = await checkNoCopy(streamFiles(files), { name });
    report.files = files.map(file => path.relative(root, file));
    const out = path.resolve(value('out') ?? path.join(root, 'eval/reports/current/rights', `no-copy-${name}.json`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(`${name}: ${report.pass ? 'PASS' : 'FAIL'} rows=${report.rows} paired_distinctive_4grams=${report.paired.distinctive_shared_4grams} (stock ${report.paired.shared_4grams_total - report.paired.distinctive_shared_4grams}) (lineage rows ${report.paired.rows_with_lineage}, source matches ${report.paired.lineage_matches_in_sources}) rows_with_shared_8gram=${report.long_span.rows_with_shared_8gram} global_4gram_distinct_rate=${report.global_4gram.distinct_rate} rows_with_identifier=${report.identifiers.rows_with_identifier} -> ${path.relative(process.cwd(), out)}`);
    if (!report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(`no-copy check could not run: ${error.stack ?? error.message}`);
    process.exit(2);
  }
}
