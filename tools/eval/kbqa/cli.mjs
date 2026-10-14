#!/usr/bin/env node
/**
 * The end-to-end knowledge-base question-answering evaluation (KBQA, experiment eval-kbqa-v1): public benchmark questions answered from
 * Wikidata facts through the product chain, in process (no server, no port):
 *   question -> step-by-step formalizer (server/query-parser.mjs) -> Agent (server/agent.mjs: admission, KnowledgeLinker sop/linking.mjs + sop/copula-linker.mjs,
 *   the reasoning reference route over the base memory kbqa-<name>) -> answer -> compared with the gold.
 *
 *   node tools/eval/kbqa/cli.mjs suites   [--suite mintaka|lcquad2|simplequestions|qald10|all] [--size 1000]   # sealed eval/suites/kbqa-<name>/test.jsonl
 *   node tools/eval/kbqa/cli.mjs slice    --suite <name> [--stage 100|300|all]   # only fetches (and caches) the Wikidata slice
 *   node tools/eval/kbqa/cli.mjs build    --suite <name> [--stage 100|300|all]   # Wikidata slice -> circuits + host lexicon -> base memory kbqa-<name>
 *   node tools/eval/kbqa/cli.mjs run      --suite <name> [--stage 100|300|all] [--variant lex] [--tier tiny|small|medium|good] [--tag m0] [--force]   # the chain on every question; per-question records (tag = a rerun on a newer component state)
 *   node tools/eval/kbqa/cli.mjs report   [--suite <name>|all]                   # scores, attribution, summary.md
 *   node tools/eval/kbqa/cli.mjs baseline --suite <name> --stage 100 [--model qwen27b|deepseek] [--shards 10] [--concurrency 3]  # task folders, direct Ploinky calls: an LLM answers from the same slice as text
 *   node tools/eval/kbqa/cli.mjs baseline-score --suite <name> --stage 100 --model qwen27b   # scores the answers.jsonl of the shards
 *
 * Outputs: eval/reports/current/kbqa/<name>/stage-<n>.jsonl (one record per question), eval/reports/current/kbqa/summary.{md,json}.
 * The gold answers are read only here and by the scorer; no generator or training code reads eval/suites/** (AGENTS.md rule 9).
 */
import {buildSuite} from './suites.mjs';
import {BENCHMARKS} from './benchmarks.mjs';

const args = process.argv.slice(2);
const command = args[0];
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const suites = (value => (value === 'all' ? Object.keys(BENCHMARKS) : value.split(',')))(opt('--suite', 'all'));
const stage = opt('--stage', '100');

if (command === 'suites') {
  const results = [];
  for (const name of suites) results.push(await buildSuite(name, {size: Number(opt('--size', 1000))}));
  console.log(JSON.stringify(results, null, 2));
} else if (command === 'slice') {
  const {loadSlice} = await import('./memory.mjs');
  for (const name of suites) { const slice = await loadSlice(name, stage); console.log(JSON.stringify({suite: name, stage, statements: slice.triples.length, items: slice.items.size, properties: slice.properties.size})); }
} else if (command === 'build') {
  const {buildMemory} = await import('./memory.mjs');
  for (const name of suites) console.log(JSON.stringify(await buildMemory(name, {stage, variant: opt('--variant', '')}), null, 2));
} else if (command === 'run') {
  const {runSuite} = await import('./run.mjs');
  for (const name of suites) console.log(JSON.stringify(await runSuite(name, {stage, limit: opt('--limit', null), only: opt('--only', null), variant: opt('--variant', ''), tier: opt('--tier', null), tag: (opt('--variant', '') ? '-' + opt('--variant', '') : '') + (opt('--parser', 'local') !== 'local' ? '-' + opt('--parser') : '') + (opt('--tag', '') ? '-' + opt('--tag', '') : ''), force: args.includes('--force')}), null, 2));
} else if (command === 'report') {
  const {writeReport} = await import('./report.mjs');
  console.log(JSON.stringify(await writeReport({suites}), null, 2));
} else if (command === 'baseline') {
  const {runBaseline} = await import('./baseline.mjs');
  for (const name of suites) console.log(JSON.stringify(await runBaseline(name, {stage, model: opt('--model', 'qwen27b'), shards: Number(opt('--shards', 10)), concurrency: Number(opt('--concurrency', 3))}), null, 2));
} else if (command === 'baseline-score') {
  const {scoreBaseline} = await import('./baseline.mjs');
  for (const name of suites) console.log(JSON.stringify(scoreBaseline(name, {stage, model: opt('--model', 'qwen27b')}), null, 2));
} else {
  console.error('usage: node tools/eval/kbqa/cli.mjs suites|slice|build|run|report|baseline|baseline-score [--suite <name>] [--stage 100|300|all]');
  process.exit(2);
}
// Open handles of the memory repositories and of fetch keep-alive sockets would hold the process: the work is done.
process.exit(0);
