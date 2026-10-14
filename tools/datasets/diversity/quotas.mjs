/** Diversity quotas, balanced resource choice, split partitions and the generator's own diversity metrics.
 *
 * The generator never imports the sealed auditor (tools/datasets/audit/**); these metrics are its own
 * build-time guard, and the independent audit runs afterwards.
 */
import { hash32, words } from './text.mjs';
import { RESOURCE_ROLES, isOodOnly, testReserved } from './heldout.mjs';

/** Quotas enforced on every build (pilot and full). Shares are fractions of rows. */
export const QUOTAS = Object.freeze({
  max_masked_template_share: 0.02,       // no masked message template above 2% of rows
  max_top10_template_share: 0.12,        // the ten commonest masked templates together
  max_question_frame_share: 0.08,        // no single outer question frame above 8% of rows
  max_family_share: 0.15,                // no single family above 15% of rows
  min_target_skeletons_total: 40,        // distinct IR skeletons across the build
  min_target_skeletons_per_family: 2,    // for families with at least 10 rows (unclear: one per kind)
  language_shares: { en: [0.40, 0.60], ro: [0.25, 0.45], mixed: [0.08, 0.22] },
  noise_share: [0.12, 0.35],
  unclear_share: [0.05, 0.12],
  max_near_duplicate_share: 0.05,        // MinHash word 3-shingles, Jaccard >= 0.8, outside the split group
  // Full-regeneration mix (DS015): no single inspiration source above 25% of rows, the operator families at
  // least 25% together, each formerly blocked family at least 1.5%, and a floor for every question type.
  max_source_share: 0.25,
  min_operator_share: 0.25,
  min_formerly_blocked_share: 0.015,
  min_interpretation_share: 0.015,
  question_type_minima: { universal: 0.03, when: 0.015, since_when: 0.01, until_when: 0.01, how_long: 0.01, how_many_times: 0.01, where: 0.015, why: 0.015, how: 0.01, wh: 0.04, count: 0.02, yes_no: 0.2, claim_check: 0.01, numeric: 0.015, multi: 0.01, none: 0.01, unclear: 0.05 },
});
/** Operator families: joins, temporal at/during/as-of, filters, count, constraints, conjunctions, the query-v2
 * anchors, time-variable questions and universal questions. */
export const OPERATOR_FAMILIES = Object.freeze(['join', 'temporal', 'filter', 'count', 'constraint', 'conjunction', 'anchor', 'time_question', 'general_quantification']);
export const FORMERLY_BLOCKED_FAMILIES = Object.freeze(['abduction', 'default_exception', 'counterfactual', 'planning', 'causal', 'intention', 'general_quantification']);
/** Primary inspiration source of a row: the first of `lineage.inspired_by`, or `authored` (unclear rows). */
export const primarySource = row => row.lineage?.inspired_by?.[0] ?? 'authored';

/**
 * Banned message patterns: phrasing that presupposes a knowledge base, vocabulary or record the model cannot
 * see (the model's input is the user's message only), quoted vocabulary conditions, pipeline stages, and ids.
 * Found in the old corpora by the no-context sweep (eval/reports/history/no-context-sweep.json).
 */
export const BANNED_PATTERNS = Object.freeze([
  ['vocabulary_reference', /\b(din vocabular|in the vocabulary|from the vocabulary|the shortlist|the context|knowledge base|the database)\b/i],
  ['quoted_condition', /[«»]/],
  ['pipeline_stage', /\breview stage \d+|\bstage \d+ of review/i],
  ['record_framing_en', /\b(on record|the record|the records|registry|register|ledger|dossier|casebook|archive|archival|catalogue|on file|filed|accession)\b/i],
  ['record_framing_ro', /\b(registru|registrul|arhiv\w*|dosar\w*|evidenț\w*|fișa|fișei|catalog\w*|consemnat)\b/i],
  ['case_id', /\b[a-z]{1,4}[-_](qqp|paws|qa2d|ambignq|proofwriter)[-_]\d+|\bdv_\d{5}|\b[a-z]+_\d+(_\d+)+\b/i],
  ['hash_like_name', /\b\p{Lu}\p{Ll}{2,}\d+\p{L}*\b/u],
]);
export const bannedFindings = text => BANNED_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);

/** Share of rows reserved for the sealed test when resources are partitioned. */
export const HELDOUT_MODULUS = 4;
/** A resource (frame, template, joiner, name) is test-reserved when its hash falls in the held-out bucket and
 * its option list is large enough that train/dev keep at least two alternatives. */
export const isHeldout = (id, listSize = Infinity) => listSize >= 3 && hash32(`heldout:${id}`) % HELDOUT_MODULUS === 0;
export const nameIsHeldout = name => hash32(`heldout-name:${name}`) % HELDOUT_MODULUS === 0;

/** Balanced, partition-aware choice of generator resources. */
export class Chooser {
  constructor(random) {
    this.random = random;
    this.usage = new Map();
    this.split = 'train';
    this.log = [];
  }
  setSplit(split) { this.split = split; }
  /** Test-reserved options of a list. A registered resource (heldout.mjs: frame tables and constructions) keeps
   * the role computed over its full list, whatever sub-list the call site passes; any other list reserves
   * exactly floor(n/4) of its non-OOD options (at least one from three up), the ones with the lowest stable hash,
   * so train and dev always keep three quarters of every list. */
  reservedOf(options) {
    if (options.length && options.every(option => RESOURCE_ROLES.has(option.id))) return new Set(options.filter(option => RESOURCE_ROLES.get(option.id) === 'test').map(option => option.id));
    return testReserved(options);
  }
  /** The options a split may use. OOD-only options never reach formalizer-v1; the OOD suite (split `ood`) uses the
   * OOD-only and test-reserved options (none of them occurs in train or dev) and falls back to shared options
   * only when nothing else fits (build-corpora.mjs then drops the row by the overlap filter). */
  allowed(options) {
    const ood = options.filter(option => isOodOnly(option.id));
    const rest = options.filter(option => !isOodOnly(option.id));
    const reserved = this.reservedOf(rest);
    const test = rest.filter(option => reserved.has(option.id)), shared = rest.filter(option => !reserved.has(option.id));
    if (this.split === 'ood') return ood.length || test.length ? [...ood, ...test] : shared;
    if (this.split === 'test') return test.length ? test : shared;
    return shared.length ? shared : test;
  }
  pick(kind, options) {
    if (!options?.length) return null;
    const pool = this.allowed(options);
    if (!pool.length) return null;
    const weights = pool.map(option => [option, 1 / (1 + (this.usage.get(option.id) ?? 0)) ** 2]);
    const chosen = this.random.weighted(weights);
    this.usage.set(chosen.id, (this.usage.get(chosen.id) ?? 0) + 1);
    this.log.push(chosen.id);
    return chosen;
  }
  bound() { const choose = (kind, options) => this.pick(kind, options); choose.chooser = this; return choose; }
}

// ---------------------------------------------------------------- diversity metrics (generator-side)
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Masked template: entity surfaces → E, other capitalized non-initial words → E, digits → N. */
export function maskedTemplate(text, surfaces = []) {
  let out = String(text);
  for (const surface of [...surfaces].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escape(surface), 'g'), ' E ');
  out = out.replace(/\d+([.:/-]\d+)*/g, ' N ');
  const tokens = out.split(/\s+/).filter(Boolean);
  return tokens.map((token, index) => index > 0 && /^\p{Lu}\p{Ll}/u.test(token) && !/^(I|I'm|I'd)$/.test(token) ? 'E' : token.toLowerCase())
    .join(' ').replace(/\b(E\s*)+/g, 'E ').replace(/\s+/g, ' ').trim();
}

function minhash(text, k = 64) {
  const tokens = words(text);
  const shingles = new Set();
  for (let i = 0; i + 3 <= tokens.length; i++) shingles.add(hash32(tokens.slice(i, i + 3).join(' ')));
  if (!shingles.size) shingles.add(hash32(tokens.join(' ')));
  const signature = [];
  for (let seed = 0; seed < k; seed++) {
    let min = Infinity;
    for (const shingle of shingles) min = Math.min(min, (Math.imul(shingle ^ (seed * 0x9e3779b1), 0x85ebca6b) >>> 0));
    signature.push(min);
  }
  return signature;
}
const similarity = (a, b) => a.filter((value, index) => value === b[index]).length / a.length;

const entropy = counts => {
  const total = counts.reduce((a, b) => a + b, 0);
  return -counts.reduce((sum, count) => sum + (count / total) * Math.log2(count / total), 0);
};

const shares = (rows, key) => {
  const tally = {};
  for (const row of rows) { const k = key(row); tally[k] = (tally[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number((v / (rows.length || 1)).toFixed(4))]));
};
/** Diversity metrics of a set of rows: {template shares, entropy, skeletons, near duplicates, languages, mix}. */
export function diversityMetrics(rows) {
  const templates = new Map(), frames = new Map(), skeletons = new Map(), families = new Map(), bigrams = new Map(), unigrams = new Map();
  for (const row of rows) {
    const t = row.surface_design?.masked_template ?? maskedTemplate(row.question);
    templates.set(t, (templates.get(t) ?? 0) + 1);
    const frame = row.surface_design?.question_frame ?? 'none';
    frames.set(frame, (frames.get(frame) ?? 0) + 1);
    skeletons.set(`${row.family}|${row.ir_skeleton}`, (skeletons.get(`${row.family}|${row.ir_skeleton}`) ?? 0) + 1);
    families.set(row.family, (families.get(row.family) ?? 0) + 1);
    const tokens = t.split(' ');
    tokens.forEach((token, index) => {
      unigrams.set(token, (unigrams.get(token) ?? 0) + 1);
      if (index) bigrams.set(`${tokens[index - 1]} ${token}`, (bigrams.get(`${tokens[index - 1]} ${token}`) ?? 0) + 1);
    });
  }
  const sorted = [...templates.values()].sort((a, b) => b - a);
  const n = rows.length || 1;
  // Near duplicates with locality-sensitive hashing: 16 bands of 4 MinHash values; only rows sharing a band
  // bucket are compared, so the check stays linear in practice at corpus scale.
  const signatures = rows.map(row => minhash(row.question));
  const buckets = new Map();
  signatures.forEach((signature, index) => { for (let band = 0; band < 16; band++) { const key = `${band}:${signature.slice(band * 4, band * 4 + 4).join(',')}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(index); } });
  const flagged = new Set(), nearExamples = [];
  for (const members of buckets.values()) {
    if (members.length < 2 || members.length > 2000) continue;
    for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
      const i = members[a], j = members[b];
      if (rows[i].split_group_id === rows[j].split_group_id || rows[i].split !== rows[j].split || (flagged.has(i) && flagged.has(j))) continue;
      if (similarity(signatures[i], signatures[j]) >= 0.8) { flagged.add(i); flagged.add(j); if (nearExamples.length < 5) nearExamples.push([rows[i].id, rows[j].id]); }
    }
  }
  const near = flagged.size;
  const perFamily = {};
  for (const key of skeletons.keys()) { const [family] = key.split('|'); perFamily[family] = (perFamily[family] ?? 0) + 1; }
  const byLanguage = {};
  for (const row of rows) { const key = row.code_switch ? 'mixed' : row.language; byLanguage[key] = (byLanguage[key] ?? 0) + 1; }
  return {
    rows: rows.length,
    masked_templates: templates.size, template_ratio: Number((templates.size / n).toFixed(4)),
    top1_template_share: Number(((sorted[0] ?? 0) / n).toFixed(4)), top10_template_share: Number((sorted.slice(0, 10).reduce((a, b) => a + b, 0) / n).toFixed(4)),
    top_templates: [...templates].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([template, count]) => ({ template, count })),
    masked_unigram_entropy_bits: Number(entropy([...unigrams.values()]).toFixed(3)), masked_bigram_entropy_bits: Number(entropy([...bigrams.values()]).toFixed(3)),
    question_frames: frames.size, top_question_frame_share: Number((Math.max(...frames.values()) / n).toFixed(4)),
    target_skeletons: skeletons.size, target_skeletons_per_family: perFamily,
    family_shares: Object.fromEntries([...families].map(([family, count]) => [family, Number((count / n).toFixed(4))])),
    language_shares: Object.fromEntries(Object.entries(byLanguage).map(([language, count]) => [language, Number((count / n).toFixed(4))])),
    noise_share: Number((rows.filter(row => row.noise?.length).length / n).toFixed(4)),
    unclear_share: Number((rows.filter(row => row.family === 'unclear').length / n).toFixed(4)),
    near_duplicate_share: Number((near / n).toFixed(4)), near_duplicate_examples: nearExamples,
    question_type_shares: shares(rows, row => row.question_type ?? 'unlabelled'),
    source_shares: shares(rows, primarySource),
    operator_share: Number((rows.filter(row => OPERATOR_FAMILIES.includes(row.family)).length / n).toFixed(4)),
    interpretation_share: Number((rows.filter(row => row.surface_ir?.assumed?.some(a => a.basis === 'disambiguation' || a.basis === 'implicature')).length / n).toFixed(4)),
  };
}

/** Check metrics against QUOTAS; returns a list of violations (empty = pass). Small builds skip share bounds
 * that are statistically meaningless below `minRows`. */
export function quotaViolations(metrics, rows, { minRows = 200, mix = true } = {}) {
  const v = [];
  const q = QUOTAS;
  if (metrics.top1_template_share > q.max_masked_template_share && metrics.rows >= minRows) v.push(`top masked template share ${metrics.top1_template_share} > ${q.max_masked_template_share}`);
  if (metrics.top10_template_share > q.max_top10_template_share && metrics.rows >= minRows) v.push(`top-10 masked template share ${metrics.top10_template_share} > ${q.max_top10_template_share}`);
  if (metrics.top_question_frame_share > q.max_question_frame_share && metrics.rows >= minRows) v.push(`top question frame share ${metrics.top_question_frame_share} > ${q.max_question_frame_share}`);
  for (const [family, share] of Object.entries(metrics.family_shares)) if (share > q.max_family_share) v.push(`family ${family} share ${share} > ${q.max_family_share}`);
  if (metrics.target_skeletons < q.min_target_skeletons_total) v.push(`target skeletons ${metrics.target_skeletons} < ${q.min_target_skeletons_total}`);
  const familyRows = rows.reduce((tally, row) => ({ ...tally, [row.family]: (tally[row.family] ?? 0) + 1 }), {});
  for (const [family, count] of Object.entries(familyRows)) if (count >= 10 && family !== 'unclear' && (metrics.target_skeletons_per_family[family] ?? 0) < q.min_target_skeletons_per_family) v.push(`family ${family} has ${metrics.target_skeletons_per_family[family]} target skeletons`);
  for (const [language, [lo, hi]] of Object.entries(q.language_shares)) { const share = metrics.language_shares[language] ?? 0; if (share < lo || share > hi) v.push(`language ${language} share ${share} outside [${lo}, ${hi}]`); }
  if (metrics.noise_share < q.noise_share[0] || metrics.noise_share > q.noise_share[1]) v.push(`noise share ${metrics.noise_share} outside ${q.noise_share}`);
  if (metrics.unclear_share < q.unclear_share[0] || metrics.unclear_share > q.unclear_share[1]) v.push(`unclear share ${metrics.unclear_share} outside ${q.unclear_share}`);
  if (metrics.near_duplicate_share > q.max_near_duplicate_share) v.push(`near-duplicate share ${metrics.near_duplicate_share} > ${q.max_near_duplicate_share}`);
  if (mix) {
    for (const [source, share] of Object.entries(metrics.source_shares)) if (share > q.max_source_share) v.push(`source ${source} share ${share} > ${q.max_source_share}`);
    if (metrics.operator_share < q.min_operator_share) v.push(`operator families share ${metrics.operator_share} < ${q.min_operator_share}`);
    for (const family of FORMERLY_BLOCKED_FAMILIES) if ((metrics.family_shares[family] ?? 0) < q.min_formerly_blocked_share) v.push(`formerly blocked family ${family} share ${metrics.family_shares[family] ?? 0} < ${q.min_formerly_blocked_share}`);
    if (metrics.interpretation_share < q.min_interpretation_share) v.push(`interpretation assumptions share ${metrics.interpretation_share} < ${q.min_interpretation_share}`);
    for (const [type, minimum] of Object.entries(q.question_type_minima)) if ((metrics.question_type_shares[type] ?? 0) < minimum) v.push(`question type ${type} share ${metrics.question_type_shares[type] ?? 0} < ${minimum}`);
  }
  const banned = rows.map(row => [row.id, bannedFindings(row.question)]).filter(([, found]) => found.length);
  if (banned.length) v.push(`banned patterns in ${banned.length} rows, e.g. ${JSON.stringify(banned.slice(0, 3))}`);
  return v;
}
