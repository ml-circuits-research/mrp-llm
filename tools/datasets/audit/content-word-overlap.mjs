#!/usr/bin/env node
/** Content-word overlap of the sealed test rows with train and dev (DSx008 "Content-word overlap").
 *
 *   node tools/datasets/audit/content-word-overlap.mjs [--dataset NAME] [--out file] [--no-write] [--min-words 2] [--largely 0.8]
 *
 * Owner philosophy (2026-09-30): evaluation is an engineering check; a test may repeat a grammatical FORM but must not
 * duplicate a CASE (same names, nouns and verbs). For each of the three datasets every sealed test row is compared with
 * the train and dev rows of the same dataset on
 *   (a) exact and normalized text duplicates (also against the other two datasets; fail closed),
 *   (b) the content-word signature (lemmas of proper names, nouns and verbs; a light tokenizer for bad_english): the share
 *       of test rows whose set is identical to, or largely contained in (>= --largely of the test row's words), the set of
 *       a train/dev row of the same form (report only),
 *   (c) the form signature: how many test rows share a form with train/dev, the test forms with no train/dev
 *       counterpart and the train/dev forms with no test counterpart (test variants count as test rows; information).
 * A "lexical duplicate" is identical content-word signature (at least --min-words words) AND identical form (all
 * sentences); it fails closed like (a). Exit code 1 on (a) or a lexical duplicate. The report is
 * eval/reports/current/three-datasets/content-word-overlap.json. Reads the sealed test only as a validator does.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJsonlShardedSync, jsonlExists} from '../../../lib/jsonl-shards.mjs';
import {ROOT, THREE_DATASETS} from '../../../lib/dataset-paths.mjs';
import {normalText} from '../three-datasets/inputs.mjs';
import {signatureOf, coverage} from '../three-datasets/forms.mjs';

const MAX_EXAMPLES = 12;
const splitFile = (dataset, split) => (split === 'test' ? `eval/suites/${dataset}/test.jsonl` : `datasets/${dataset}/${split}.jsonl`);
const load = (dataset, split, root) => { const file = path.join(root, splitFile(dataset, split)); return jsonlExists(file) ? readJsonlShardedSync(file) : []; };
const pct = (k, n) => (n ? Math.round(1000 * k / n) / 10 : null);
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/**
 * Overlap of `testRows` with `poolRows` (same dataset). `otherPools` are the train/dev rows of the other datasets, only
 * used for exact-duplicate detection. Rows are plain dataset rows.
 */
export function overlapOf(testRows, poolRows, {otherPools = [], minWords = 2, largely = 0.8, extraTestRows = []} = {}) {
  const pool = poolRows.map(row => ({id: row.id, message: row.message, sig: signatureOf(row), norm: normalText(row.message), targets: (row.targets ?? []).map(t => normalText(t.text))}));
  const byNorm = new Map(), byForm = new Map(), byKey = new Map();
  for (const p of pool) {
    (byNorm.get(p.norm) ?? byNorm.set(p.norm, []).get(p.norm)).push(p);
    (byForm.get(p.sig.form) ?? byForm.set(p.sig.form, []).get(p.sig.form)).push(p);
    const key = `${p.sig.full}#${p.sig.words.join(' ')}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)).push(p);
  }
  const otherNorm = new Map();
  for (const {dataset, rows} of otherPools) for (const r of rows) if (!otherNorm.has(normalText(r.message))) otherNorm.set(normalText(r.message), {dataset, id: r.id});
  const targetNorms = new Set(pool.flatMap(p => p.targets));

  const out = {
    test_rows: testRows.length, pool_rows: pool.length,
    exact_duplicates: {same_dataset: 0, other_dataset: 0, normalized_only: 0, examples: []},
    target_text_also_in_pool_targets: 0,
    content_words: {rows_with_signature: 0, rows_with_enough_words: 0, identical_any_form: 0, identical_same_form: 0, largely_contained_same_form: 0, no_same_form_row: 0, unique_words: 0, examples: []},
    forms: {test_forms: 0, pool_forms: byForm.size, pool_forms_without_test_counterpart: 0, pool_forms_without_test_counterpart_examples: [], test_rows_sharing_a_form: 0, test_forms_with_pool_counterpart: 0, test_forms_without_pool_counterpart: 0, rows_of_forms_without_counterpart: 0, uncovered: []},
    lexical_duplicates: {count: 0, examples: []},
  };
  const testForms = new Map();
  for (const row of testRows) {
    const sig = signatureOf(row);
    const norm = normalText(row.message);
    bump(testForms, sig.form);
    // (a) duplicates
    const same = byNorm.get(norm);
    if (same) {
      out.exact_duplicates.same_dataset++;
      if (!same.some(p => p.message === row.message)) out.exact_duplicates.normalized_only++;
      if (out.exact_duplicates.examples.length < MAX_EXAMPLES) out.exact_duplicates.examples.push({test: row.id, pool: same[0].id, message: row.message.slice(0, 120)});
    } else if (otherNorm.has(norm)) {
      out.exact_duplicates.other_dataset++;
      if (out.exact_duplicates.examples.length < MAX_EXAMPLES) out.exact_duplicates.examples.push({test: row.id, pool: `${otherNorm.get(norm).dataset}:${otherNorm.get(norm).id}`, message: row.message.slice(0, 120)});
    }
    if (row.target && targetNorms.has(normalText(row.target))) out.target_text_also_in_pool_targets++;
    // (b) content words
    out.content_words.rows_with_signature++;
    const candidates = byForm.get(sig.form) ?? [];
    if (!candidates.length) out.content_words.no_same_form_row++;
    if (sig.words.length >= minWords) {
      out.content_words.rows_with_enough_words++;
      const identicalAny = pool.some(p => p.sig.words.length === sig.words.length && p.sig.words.every((w, i) => w === sig.words[i]));
      const exactKey = byKey.get(`${sig.full}#${sig.words.join(' ')}`);
      const identicalSame = candidates.some(p => p.sig.words.length === sig.words.length && p.sig.words.every((w, i) => w === sig.words[i]));
      let contained = null;
      for (const p of candidates) if (coverage(sig.words, p.sig.words) >= largely) { contained = p; break; }
      if (identicalAny) out.content_words.identical_any_form++;
      if (identicalSame) out.content_words.identical_same_form++;
      if (contained) out.content_words.largely_contained_same_form++;
      if ((identicalSame || contained) && out.content_words.examples.length < MAX_EXAMPLES) out.content_words.examples.push({test: row.id, pool: (contained ?? candidates[0]).id, words: sig.words.slice(0, 8), test_message: row.message.slice(0, 100), pool_message: (contained ?? candidates[0]).message.slice(0, 100), identical: identicalSame});
      if (exactKey) {
        out.lexical_duplicates.count++;
        if (out.lexical_duplicates.examples.length < MAX_EXAMPLES) out.lexical_duplicates.examples.push({test: row.id, pool: exactKey[0].id, words: sig.words, test_message: row.message.slice(0, 120), pool_message: exactKey[0].message.slice(0, 120)});
      }
    }
    if (candidates.length) out.forms.test_rows_sharing_a_form++;
  }
  out.forms.test_forms = testForms.size;
  for (const [form, n] of [...testForms].sort((a, b) => b[1] - a[1])) {
    if (byForm.has(form)) out.forms.test_forms_with_pool_counterpart++;
    else {
      out.forms.test_forms_without_pool_counterpart++;
      out.forms.rows_of_forms_without_counterpart += n;
      if (out.forms.uncovered.length < 40) out.forms.uncovered.push({form, rows: n, example: testRows.find(r => signatureOf(r).form === form)?.message.slice(0, 120)});
    }
  }
  const testFormsAll = new Set([...testForms.keys(), ...extraTestRows.map(r => signatureOf(r).form)]);
  const poolOnly = [...byForm].filter(([form]) => !testFormsAll.has(form));
  out.forms.pool_forms_without_test_counterpart = poolOnly.length;
  out.forms.pool_forms_without_test_counterpart_examples = poolOnly.sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([form, rows]) => ({form, rows: rows.length, example: rows[0].message.slice(0, 120)}));
  const c = out.content_words, f = out.forms;
  out.shares = {
    exact_duplicate_pct: pct(out.exact_duplicates.same_dataset + out.exact_duplicates.other_dataset, out.test_rows),
    identical_words_same_form_pct: pct(c.identical_same_form, c.rows_with_enough_words),
    largely_contained_same_form_pct: pct(c.largely_contained_same_form, c.rows_with_enough_words),
    form_shared_pct: pct(f.test_rows_sharing_a_form, out.test_rows),
    forms_covered_pct: pct(f.test_forms_with_pool_counterpart, f.test_forms),
  };
  return out;
}

export function run({root = ROOT, datasets = THREE_DATASETS, minWords = 2, largely = 0.8, loadRows = load} = {}) {
  // Composed paragraphs (tools/datasets/composed-train.mjs) are working data made of train/dev sentences: their paragraph skeleton is not a form and they cannot duplicate a sealed sentence.
  const pools = Object.fromEntries(datasets.map(d => [d, ['train', 'dev'].flatMap(s => loadRows(d, s, root)).filter(r => r.source?.corpus !== 'composed')]));
  const report = {generated_at: new Date().toISOString(), method: 'content words = lemmas of PROPN/NOUN/VERB of the stored analysis (light tokenizer without analysis); form = analysis skeleton of the forms inventory; see DSx008 "Content-word overlap"', min_words: minWords, largely_contained_threshold: largely, datasets: {}, failures: []};
  for (const d of datasets) {
    const test = loadRows(d, 'test', root);
    const others = datasets.filter(o => o !== d).map(o => ({dataset: o, rows: pools[o]}));
    // The sealed test variants of symbolic_english (tools/eval/test-variants.mjs) are test rows of forms only the training side has.
    const variantsFile = path.join(root, 'eval/suites', d, 'test-variants.jsonl');
    const extraTestRows = jsonlExists(variantsFile) ? readJsonlShardedSync(variantsFile) : [];
    const result = overlapOf(test, pools[d], {otherPools: others, minWords, largely, extraTestRows});
    report.datasets[d] = result;
    const dup = result.exact_duplicates.same_dataset + result.exact_duplicates.other_dataset;
    if (dup) report.failures.push(`${d}: ${dup} sealed test row(s) duplicate a train/dev message (normalized)`);
    if (result.lexical_duplicates.count) report.failures.push(`${d}: ${result.lexical_duplicates.count} test row(s) with identical content-word signature and identical form as a train/dev row`);
  }
  return report;
}

const parseArgs = argv => { const o = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; return o; };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  const report = run({datasets: o.dataset ? [o.dataset] : THREE_DATASETS, minWords: Number(o['min-words'] ?? 2), largely: Number(o.largely ?? 0.8)});
  const outFile = path.resolve(ROOT, o.out ?? 'eval/reports/current/three-datasets/content-word-overlap.json');
  if (!o['no-write']) { fs.mkdirSync(path.dirname(outFile), {recursive: true}); fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n'); }
  for (const [d, r] of Object.entries(report.datasets)) console.log(`${d}: ${r.test_rows} test rows; exact duplicates ${r.exact_duplicates.same_dataset + r.exact_duplicates.other_dataset}; identical words + form ${r.content_words.identical_same_form}/${r.content_words.rows_with_enough_words} (${r.shares.identical_words_same_form_pct}%), largely contained ${r.shares.largely_contained_same_form_pct}%; forms shared ${r.shares.form_shared_pct}% (${r.forms.test_forms_with_pool_counterpart}/${r.forms.test_forms} test forms covered, ${r.forms.pool_forms_without_test_counterpart} train/dev forms without a test row); lexical duplicates ${r.lexical_duplicates.count}`);
  for (const f of report.failures) console.error(`FAIL ${f}`);
  if (report.failures.length) process.exitCode = 1;
}
