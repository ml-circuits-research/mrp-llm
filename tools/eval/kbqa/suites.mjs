/**
 * Builds the sealed KBQA suites eval/suites/kbqa-<name>/test.jsonl (tools/eval/kbqa/cli.mjs `suites`): the stratified sample of a
 * benchmark, with the gold answers taken from the source (Mintaka, QALD-10) or obtained by running the benchmark's gold SPARQL on the
 * current Wikidata (LC-QuAD 2.0 and SimpleQuestions-Wikidata carry no answers). A row whose gold query returns nothing on today's
 * Wikidata is dropped (counted in the suite's meta file): it cannot be answered from any Wikidata slice.
 */
import fs from 'node:fs';
import path from 'node:path';
import {BENCHMARKS, LOADERS, stratifiedSample, suiteFile, answerOf, download} from './benchmarks.mjs';
import {sparql, hash} from './wikidata.mjs';

const MAX_GOLD = 2000;

async function goldFromSparql(row) {
  let q = row.sparql;
  const ask = /^\s*ask\b/i.test(q.replace(/PREFIX\s+\S+\s+<[^>]*>/gi, '').trim());
  if (!ask && !/\bLIMIT\s+\d+\s*$/i.test(q.trim())) q = `${q.trim()} LIMIT ${MAX_GOLD}`;
  let rows;
  try { rows = await sparql(`gold-${hash(q)}`, q, {timeoutMs: 70000, retries: 2}); } catch { return {kind: 'error', answers: []}; }
  if (ask) return {kind: 'boolean', answers: rows.length ? [{kind: 'boolean', value: rows[0].boolean === 'true'}] : []};
  const answers = [];
  for (const r of rows) for (const v of Object.values(r)) { const a = answerOf(v); if (a) answers.push(a); }
  const seen = new Set();
  const unique = answers.filter(a => { const k = JSON.stringify(a); if (seen.has(k)) return false; seen.add(k); return true; });
  return {kind: unique[0]?.kind ?? 'entity', answers: unique, truncated: rows.length >= MAX_GOLD};
}

/** Writes the suite incrementally (every 25 rows), so a long gold fetch can be used for the early stages while it runs. */
export async function buildSuite(name, {size = 1000, seed = 'kbqa-v1', log = console.error} = {}) {
  await download(name);
  const all = LOADERS[name]();
  const needsGold = all.some(r => !r.gold);
  // Oversample when the gold comes from WDQS: some gold queries return nothing on today's Wikidata.
  const sample = stratifiedSample(all, {size: needsGold ? Math.round(size * 1.3) : size, seed});
  const file = suiteFile(name);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const meta = {benchmark: name, ...BENCHMARKS[name], seed, population: all.length, sampled: 0, dropped_no_gold: 0, dropped_error: 0, built_at: new Date().toISOString(),
    gold_source: needsGold ? 'gold SPARQL executed on query.wikidata.org at build time (answers capped at 2000)' : 'answers shipped with the benchmark'};
  const out = [];
  const perType = new Map();
  const quota = Math.ceil(size / new Set(sample.map(r => r.type)).size);
  const flush = () => {
    fs.writeFileSync(file, out.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(path.dirname(file), 'meta.json'), JSON.stringify({...meta, sampled: out.length, types: Object.fromEntries(perType)}, null, 2) + '\n');
  };
  for (const r of sample) {
    if (out.length >= size) break;
    if (needsGold && (perType.get(r.type) ?? 0) >= quota && sample.length > size) continue;
    const gold = r.gold ?? await goldFromSparql(r);
    if (gold.kind === 'error') { meta.dropped_error++; continue; }
    if (!gold.answers.length) { meta.dropped_no_gold++; continue; }
    // SimpleQuestions asks for one object ("name an indie rock artist"): any gold value is a correct answer.
    const anyOf = name === 'simplequestions';
    out.push({id: `kbqa-${name}-${r.source_id}`, benchmark: name, source_id: r.source_id, question: r.question, type: r.type, native_type: r.native_type,
      entities: r.entities, properties: r.properties, sparql: r.sparql, gold: {...gold, any_of: anyOf}, ...(r.mentions ? {mentions: r.mentions} : {}),
      license: BENCHMARKS[name].license, source: BENCHMARKS[name].url});
    perType.set(r.type, (perType.get(r.type) ?? 0) + 1);
    if (out.length % 25 === 0) { flush(); log(`[suite ${name}] ${out.length}/${size}`); }
  }
  flush();
  return {name, rows: out.length, dropped_no_gold: meta.dropped_no_gold, dropped_error: meta.dropped_error};
}

export function readSuite(name, stage = 'all') {
  const rows = fs.readFileSync(suiteFile(name), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return stage === 'all' ? rows : rows.slice(0, Number(stage));
}
