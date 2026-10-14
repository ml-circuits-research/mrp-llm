#!/usr/bin/env node
/**
 * The mined vocabulary report of the linking work (linking proposal, section 5.1): which relation phrases the SymbolicLM programs of
 * `symbolic_english` and `neuro_english` (train and dev) use, how few of them cover the mentions, which role sets and value kinds they
 * carry, and how much of that the archive verification world already names. The mining itself is `tools/linking/core-en/mine.mjs`
 * (data only, no predicate names, never model input); this tool turns its result into the regenerable report.
 *
 *   node tools/linking/mine-vocabulary.mjs [--out DIR]     writes DIR/vocabulary-mined.json and DIR/vocabulary-mined.md
 *                                                          (default eval/reports/current/linking/)
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mine} from './core-en/mine.mjs';
import {phraseKey} from '../../sop/linking.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPS = [10, 25, 50, 100, 238, 500, 1000];

/** The report object for a mining result. */
export function vocabularyReport(mined) {
  const total = mined.mentions;
  const cumulative = [];
  let sum = 0;
  mined.phrases.forEach((p, i) => { sum += p.count; if (TOPS.includes(i + 1)) cumulative.push({phrases: i + 1, mentions: sum, share: +(sum / total).toFixed(4)}); });
  const archiveKeys = new Set(mined.archiveWorld.flatMap(p => [p.id, ...p.en, ...p.ro]).map(phraseKey));
  const named = mined.phrases.filter(p => archiveKeys.has(p.key));
  const copular = mined.phrases.filter(p => p.copular);
  const roleSets = {};
  for (const p of mined.phrases) for (const [set, n] of Object.entries(p.roleSets)) roleSets[set] = (roleSets[set] ?? 0) + n;
  const kinds = {};
  for (const p of mined.phrases) for (const [kind, n] of Object.entries(p.kinds)) kinds[kind] = (kinds[kind] ?? 0) + n;
  return {
    generated: mined.generated, rows: mined.rows, mentions: total, distinct_phrases: mined.distinctPhrases,
    cumulative_coverage: cumulative,
    archive_world: {predicates: mined.archiveWorld.length, phrases_named: named.length, mentions_named: named.reduce((a, p) => a + p.count, 0), share_of_mentions: +(named.reduce((a, p) => a + p.count, 0) / total).toFixed(4)},
    copular: {phrases: copular.length, mentions: copular.reduce((a, p) => a + p.count, 0), share_of_mentions: +(copular.reduce((a, p) => a + p.count, 0) / total).toFixed(4)},
    role_sets: Object.fromEntries(Object.entries(roleSets).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    value_kinds: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 25)),
    top_phrases: mined.phrases.slice(0, 40).map(p => ({phrase: p.phrase, count: p.count, rows: p.rows, role_sets: p.roleSets})),
    common_nouns_top: mined.commonNouns.slice(0, 40),
  };
}

export function vocabularyMarkdown(r) {
  const pct = x => (100 * x).toFixed(1) + '%';
  return [
    '# Mined relation vocabulary', '',
    `Generated ${r.generated} from ${r.rows} rows of symbolic_english and neuro_english (train and dev): ${r.mentions} relation mentions, ${r.distinct_phrases} distinct phrases.`, '',
    '## Cumulative coverage', '', '| top phrases | mentions | share |', '| ---: | ---: | ---: |',
    ...r.cumulative_coverage.map(c => `| ${c.phrases} | ${c.mentions} | ${pct(c.share)} |`), '',
    `Archive verification world: ${r.archive_world.predicates} predicates; they name ${r.archive_world.phrases_named} of the phrases, ${pct(r.archive_world.share_of_mentions)} of the mentions.`, '',
    `Copular phrases (be, be a, be in ...): ${r.copular.phrases} phrases, ${pct(r.copular.share_of_mentions)} of the mentions.`, '',
    '## Role sets', '', '| role set | mentions |', '| --- | ---: |', ...Object.entries(r.role_sets).map(([k, v]) => `| ${k} | ${v} |`), '',
    '## Value kinds', '', '| role:kind | values |', '| --- | ---: |', ...Object.entries(r.value_kinds).map(([k, v]) => `| ${k} | ${v} |`), '',
    '## Most frequent phrases', '', '| phrase | mentions | rows |', '| --- | ---: | ---: |', ...r.top_phrases.map(p => `| ${p.phrase} | ${p.count} | ${p.rows} |`), '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  const out = resolve(ROOT, flag > 0 ? process.argv[flag + 1] : 'eval/reports/current/linking');
  const report = vocabularyReport(mine(ROOT));
  mkdirSync(out, {recursive: true});
  writeFileSync(join(out, 'vocabulary-mined.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'vocabulary-mined.md'), vocabularyMarkdown(report));
  console.log(JSON.stringify({out, mentions: report.mentions, distinct_phrases: report.distinct_phrases, top238: report.cumulative_coverage.find(c => c.phrases === 238)?.share, archive_world_share: report.archive_world.share_of_mentions}));
}
