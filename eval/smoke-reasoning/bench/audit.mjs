#!/usr/bin/env node
/** Audit dev against independently constructed heldout preview IN MEMORY, never a sealed file. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {benchmarkCase, BENCHMARK_FAMILIES} from '../../../tools/datasets/diversity/benchmark-families.mjs';
import {worldMultihop} from '../../../tools/datasets/diversity/benchmark-world.mjs';
import {overlapOf} from '../../../tools/datasets/audit/content-word-overlap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export async function auditBenchmark({out = 'eval/smoke-reasoning/bench', count = 100} = {}) {
  const dir = path.resolve(ROOT, out);
  if (!(dir === path.join(ROOT, 'eval/smoke-reasoning/bench') || dir.startsWith(path.join(ROOT, 'eval/smoke-reasoning/bench/')))) throw new Error('Audit may read dev only');
  const dev = fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const world = await worldMultihop({split: 'preview'});
  const preview = ['f1', ...BENCHMARK_FAMILIES].flatMap(family => Array.from({length: count}, (_, i) => family === 'f1' ? world[i] : benchmarkCase(family, i, {split: 'preview'})));
  for (const [split, entries] of [['dev', dev], ['preview', preview]]) {
    const questions = entries.map(e => e.question);
    if (new Set(questions).size !== questions.length) throw new Error(`${split} has duplicate questions`);
  }
  const row = c => ({id: c.id ?? `${c.family}-${c.variant}-${c.question}`, message: c.question, dataset: 'symbolic-vs-llm-v1', source: {family: c.family}});
  const result = overlapOf(preview.map(row), dev.map(row));
  if (result.exact_duplicates.same_dataset || result.exact_duplicates.other_dataset || result.lexical_duplicates.count || result.content_words.largely_contained_same_form) throw new Error(`Dev/preview content-word overlap: ${JSON.stringify(result).slice(0, 2000)}`);
  // Explicit lexical boundary on the generated entity identifiers, independent of boilerplate question words.
  for (const family of BENCHMARK_FAMILIES) {
    const devIds = new Set(dev.filter(r => r.family === family).flatMap(r => r.question.match(/\b[\p{L}\p{N}]+_dev_\d+\b/gu) ?? []));
    const previewIds = new Set(preview.filter(r => r.family === family).flatMap(r => r.question.match(/\b[\p{L}\p{N}]+_preview_\d+\b/gu) ?? []));
    if ([...devIds].some(id => previewIds.has(id))) throw new Error(`Identifier overlap: ${family}`);
  }
  const sizes = {};
  for (const entry of dev) {
    const summary = sizes[entry.family] ??= {cases: 0, base_facts_min: Infinity, base_facts_max: 0, materialized_facts_min: Infinity, materialized_facts_max: 0, total_bytes: 0, largest_file_bytes: 0};
    summary.cases++;
    summary.base_facts_min = Math.min(summary.base_facts_min, entry.facts);
    summary.base_facts_max = Math.max(summary.base_facts_max, entry.facts);
    summary.materialized_facts_min = Math.min(summary.materialized_facts_min, entry.materialized_facts);
    summary.materialized_facts_max = Math.max(summary.materialized_facts_max, entry.materialized_facts);
    for (const name of ['knowledge.sop', 'query.sop', 'source.md', 'expected.json']) {
      const bytes = fs.statSync(path.join(dir, entry.case_dir, name)).size;
      if (bytes >= 50_000_000) throw new Error(`${entry.id}/${name} exceeds 50MB`);
      summary.total_bytes += bytes;
      summary.largest_file_bytes = Math.max(summary.largest_file_bytes, bytes);
    }
  }
  return {dev: dev.length, heldout_preview_in_memory: preview.length, overlap: result, materialized_size_by_family: sizes};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditBenchmark();
    const file = path.join(ROOT, 'eval/smoke-reasoning/bench/lexical-audit.json');
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({dev: result.dev, preview: result.heldout_preview_in_memory, lexical: result.overlap.lexical_duplicates.count, exact: result.overlap.exact_duplicates.same_dataset + result.overlap.exact_duplicates.other_dataset}));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
