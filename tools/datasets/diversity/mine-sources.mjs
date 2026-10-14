#!/usr/bin/env node
/** Mine the cached public sources for a diversity inventory: structure, label types, phenomena and statistics.
 *
 *   node tools/datasets/diversity/mine-sources.mjs [--limit N] [--out tools/datasets/diversity/inventory/inventory.json]
 *
 * Only counts, rates and masked structural skeletons (closed-class words kept, every content word replaced by X)
 * leave this module; no source sentence, name, answer or row id is written (DS011, owner decision 2026-09-28).
 * Every classifier is a documented lexical heuristic, not a semantic annotation. The authored resources of the
 * generator (names, noise and code-switching models, unclear generators, family templates) are summarized from
 * their modules so the inventory is one JSON file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUNCTION_WORDS, bump, editDistance, jaccard, maskStructure, minus, multiset, sortTally, words } from './text.mjs';
import { manifestRights } from '../rights.mjs';
import { authoredSummary } from './resources.mjs';
import { jsonlExists, readJsonlSharded } from '../../../lib/jsonl-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sources = path.join(root, 'datasets_sources');

/** Stream a source cache file, single or sharded (lib/jsonl-shards.mjs); a missing file yields nothing. */
async function* jsonl(file, limit = Infinity) {
  if (!jsonlExists(file)) return;
  let n = 0;
  for await (const row of readJsonlSharded(file)) {
    if (n++ >= limit) return;
    yield row;
  }
}

// ---------------------------------------------------------------- question types
const AUX = new Set('is are was were am do does did can could should would will shall may might must has have had'.split(' '));
const WH = ['how many', 'how much', 'how long', 'how old', 'how often', 'how far', 'how big', 'how do', 'how can', 'how to', 'how'];
export function questionType(text) {
  const w = words(text);
  if (!w.length) return 'empty';
  const lead = w.slice(0, 2).join(' ');
  for (const wh of WH) if (lead === wh || (wh.split(' ').length === 1 && w[0] === wh)) return wh.replace(' ', '_');
  if (['what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why'].includes(w[0])) {
    if (w[0] === 'what' && ['is', 'are', 'was', 'were'].includes(w[1]) && ['the', 'a', 'an'].includes(w[2]) && ['best', 'difference', 'meaning', 'name', 'purpose', 'role', 'cause', 'reason', 'way'].includes(w[3])) return `what_is_the_${w[3]}`;
    return w[0];
  }
  if (AUX.has(w[0])) return `yes_no_${['do', 'does', 'did'].includes(w[0]) ? 'do' : ['can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must'].includes(w[0]) ? 'modal' : ['has', 'have', 'had'].includes(w[0]) ? 'have' : 'be'}`;
  if (['in', 'on', 'at', 'for', 'from', 'by', 'during', 'after', 'before', 'to', 'with'].includes(w[0]) && w.slice(1, 4).some(t => ['what', 'which', 'who', 'whom', 'when'].includes(t))) return 'preposition_fronted_wh';
  if (['tell', 'explain', 'describe', 'list', 'name', 'give', 'suggest', 'help', 'recommend', 'compare', 'define'].includes(w[0])) return 'imperative_request';
  if (/\?\s*$/.test(text)) return w.some(t => ['what', 'which', 'who', 'where', 'when', 'why', 'how'].includes(t)) ? 'wh_in_situ_or_embedded' : 'declarative_question';
  return 'statement_or_fragment';
}

// ---------------------------------------------------------------- discourse forms
const EMBED = /\b(i want to know|i would like to know|i'd like to know|i wonder|does anyone know|can someone tell me|can anyone tell me|any idea|do you know|i am curious|i'm curious|could you tell me)\b/i;
export function discourseForms(text) {
  const forms = [];
  const sentences = String(text).split(/(?<=[.?!])\s+(?=\S)/).filter(s => words(s).length);
  const questions = (String(text).match(/\?/g) ?? []).length;
  if (sentences.length <= 1) forms.push('single_sentence'); else forms.push('multi_sentence');
  if (questions >= 2) forms.push('multiple_questions');
  if (sentences.length >= 2 && !/\?\s*$/.test(sentences[0]) && /\?\s*$/.test(sentences.at(-1))) forms.push('context_then_question');
  if (sentences.length >= 2 && /\?\s*$/.test(sentences[0]) && !/\?\s*$/.test(sentences.at(-1))) forms.push('question_then_elaboration');
  if (EMBED.test(text)) forms.push('embedded_question');
  if (/^\s*(tell|explain|describe|list|name|give|suggest|help|recommend|compare|define|please)\b/i.test(text)) forms.push('imperative_request');
  if (/\b(if|when|assuming|suppose|supposing|given that)\b/i.test(text) && /,/.test(text)) forms.push('conditional_frame');
  if (/\b(vs\.?|versus|difference between|better than|compared to|or)\b/i.test(text)) forms.push('comparison_or_alternative');
  if (sentences.length >= 2 && /\b(i|my|me|i'm|i've)\b/i.test(sentences.slice(0, -1).join(' '))) forms.push('first_person_background');
  if (/\(.*\)/.test(text)) forms.push('parenthetical');
  if (/["“”]/.test(text)) forms.push('quoted_material');
  if (/^\s*(since|because|as|given)\b/i.test(text)) forms.push('presupposition_clause');
  if (!/[?]\s*$/.test(text) && questionType(text) !== 'statement_or_fragment') forms.push('question_without_question_mark');
  return forms;
}

// ---------------------------------------------------------------- noise
const APOSTROPHELESS = new Set('dont cant im ive doesnt isnt wont didnt youre thats whats hows wasnt arent shouldnt wouldnt couldnt theyre lets'.split(' '));
const CHAT = new Set('u ur pls plz thx thnx r y b4 gonna wanna gotta lol idk imo btw tho cuz coz ya'.split(' '));
export function noiseFeatures(text) {
  const features = [];
  const trimmed = String(text).trim();
  if (/^[a-z]/.test(trimmed)) features.push('lowercase_start');
  if (!/[?.!)"']$/.test(trimmed)) features.push('no_terminal_punctuation');
  if (/[?!]{2,}/.test(trimmed)) features.push('repeated_punctuation');
  if (/\s[?,.!]/.test(trimmed)) features.push('space_before_punctuation');
  if (/,\S/.test(trimmed)) features.push('no_space_after_comma');
  if (/ {2,}/.test(trimmed)) features.push('double_space');
  const w = words(trimmed);
  if (w.some(t => APOSTROPHELESS.has(t))) features.push('missing_apostrophe');
  if (w.some(t => CHAT.has(t))) features.push('chat_spelling');
  if (/\b[A-Z]{3,}\b/.test(trimmed) && /[a-z]/.test(trimmed)) features.push('all_caps_word');
  if (/(\p{L})\1{2,}/u.test(trimmed)) features.push('letter_repetition');
  if (/\bi\b/.test(trimmed)) features.push('lowercase_i');
  return features;
}

/** SymSpell-style delete keys for edit-distance-1 neighbour search. */
function deletes(word) {
  const out = new Set([word]);
  for (let i = 0; i < word.length; i++) out.add(word.slice(0, i) + word.slice(i + 1));
  return out;
}
function typoOperation(typo, word) {
  if (typo.length === word.length - 1) return 'deletion';
  if (typo.length === word.length + 1) return typo.slice(0, -1) === word || typo.slice(1) === word ? 'duplication_or_insertion_edge' : /(.)\1/.test(typo) && !/(.)\1/.test(word) ? 'duplication' : 'insertion';
  const diff = [...typo].map((c, i) => c !== word[i] ? i : -1).filter(i => i >= 0);
  if (diff.length === 2 && diff[1] === diff[0] + 1 && typo[diff[0]] === word[diff[1]] && typo[diff[1]] === word[diff[0]]) return 'transposition';
  return 'substitution';
}

// ---------------------------------------------------------------- paraphrase operations
const PERSON = new Set('i my me mine you your yours we our us one someone they their'.split(' '));
const NEG = new Set(['not', 'no', 'never', "n't", 'none', 'nobody', 'nothing', 'without', "don't", "doesn't", "didn't", "isn't", "can't", "won't"]);
/** A single moved span equals swapping two adjacent blocks inside the differing window; returns the shorter block length. */
function spanMove(a, b) {
  if (a.length !== b.length) return false;
  let p = 0, q = a.length - 1;
  while (p < a.length && a[p] === b[p]) p++;
  while (q > p && a[q] === b[q]) q--;
  const A = a.slice(p, q + 1), B = b.slice(p, q + 1);
  for (let s = 1; s < A.length; s++) {
    let ok = true;
    for (let n = 0; n < A.length && ok; n++) ok = B[n] === A[(n + s) % A.length];
    if (ok) return Math.min(s, A.length - s);
  }
  return false;
}
export function paraphraseOperations(first, second) {
  const a = words(first), b = words(second);
  const ops = [];
  if (a.join(' ') === b.join(' ')) return ['punctuation_or_case_only'];
  const removed = minus(a, b), added = minus(b, a);
  if (!removed.length && !added.length) {
    const differing = a.map((t, i) => t !== b[i] ? i : -1).filter(i => i >= 0);
    if (differing.length === 2 && a[differing[0]] === b[differing[1]] && a[differing[1]] === b[differing[0]]) ops.push('two_word_swap');
    else {
      const moved = spanMove(a, b);
      ops.push(moved ? (moved >= 3 ? 'clause_or_phrase_movement' : 'word_movement') : 'multi_reordering');
    }
    return ops;
  }
  const diff = [...removed, ...added];
  if (diff.some(t => NEG.has(t))) ops.push('negation_change');
  if (diff.some(t => /\d/.test(t))) ops.push('number_change');
  if (removed.some(t => PERSON.has(t)) && added.some(t => PERSON.has(t))) ops.push('person_switch');
  if (a[0] !== b[0] && (FUNCTION_WORDS.has(a[0]) || FUNCTION_WORDS.has(b[0])) && ['what', 'which', 'who', 'how', 'why', 'where', 'when', 'is', 'are', 'can', 'do', 'does', 'should'].some(t => t === a[0] || t === b[0])) ops.push('question_frame_change');
  if (diff.some(t => t.includes("'")) || (removed.includes('not') && added.some(t => t.endsWith("n't")))) ops.push('contraction_change');
  const spelling = removed.filter(r => added.some(x => r !== x && r.length > 3 && editDistance(r, x, 2) <= 2)).length;
  if (spelling) ops.push('spelling_variant');
  if (!removed.length || !added.length) ops.push(added.length ? 'addition' : 'deletion');
  else if (diff.every(t => FUNCTION_WORDS.has(t))) ops.push('function_word_change');
  else if (removed.length <= 2 && added.length <= 2) ops.push('lexical_substitution');
  if (jaccard(a, b) < 0.4) ops.push('heavy_rewrite');
  const order = a.filter(t => b.includes(t)), order2 = b.filter(t => a.includes(t));
  if (order.length >= 3 && order.join(' ') !== order2.join(' ')) ops.push('reordering_with_edits');
  return ops.length ? ops : ['other_edit'];
}

// ---------------------------------------------------------------- ambiguity types (AmbigNQ taxonomy, lexical proxies)
const MONTH = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/;
const TIME_WORDS = new Set('first last latest recent current currently now today season episode year years century decade original new old previous next before after since until during final'.split(' '));
const TYPE_NOUNS = new Set('film movie series show tv novel book song album single game video version band group team character play musical season episode edition company brand city country state river'.split(' '));
const ROLE_NOUNS = new Set('wrote written writer sang sung singer played plays actor actress directed director produced producer composed composer founded founder designed built invented created voiced voice'.split(' '));
export function ambiguityOperation(original, rewrite) {
  const a = words(original), b = words(rewrite);
  const added = minus(b, a), removed = minus(a, b);
  const ops = [];
  if (added.some(t => /^(1[5-9]|20)\d\d$/.test(t) || /^\d+(st|nd|rd|th)$/.test(t)) || MONTH.test(added.join(' ')) || added.some(t => TIME_WORDS.has(t))) ops.push('time_dependency');
  if (a[0] !== b[0] && ['who', 'what', 'which', 'when', 'where', 'how'].includes(b[0])) ops.push('answer_type');
  if (added.some(t => TYPE_NOUNS.has(t))) ops.push('entity_reference');
  if (added.some(t => ROLE_NOUNS.has(t)) || removed.some(t => ROLE_NOUNS.has(t))) ops.push('property_or_role');
  if (/\b(in|at|of)\b/.test(added.join(' ')) && /\p{Lu}/u.test(String(rewrite).split(' ').filter(t => !String(original).includes(t)).join(' '))) ops.push('location_or_named_qualifier');
  if (!ops.length) ops.push('event_or_other_qualifier');
  return ops;
}

// ---------------------------------------------------------------- QA2D declarative rewrites
export function declarativeRewrite(question, answer, declarative) {
  const q = words(question), d = words(declarative), ans = words(answer);
  const ops = [];
  if (!d.length || !ans.length) return { ops: ['missing'], position: 'none', ratio: null };
  let index = -1;
  for (let i = 0; i + ans.length <= d.length; i++) if (ans.every((t, k) => d[i + k] === t)) { index = i; break; }
  const position = index < 0 ? 'not_verbatim' : index === 0 ? 'start' : index + ans.length >= d.length ? 'end' : 'middle';
  const wh = q[0];
  if (['who', 'what', 'which'].includes(wh) && position === 'start') ops.push('subject_wh_in_place');
  else if (['what', 'which', 'who', 'whom', 'where', 'when', 'why', 'how'].includes(wh)) ops.push('wh_fronting_undone');
  if (['do', 'does', 'did'].includes(q[1]) && !d.includes(q[1])) ops.push('do_support_removed');
  if (AUX.has(q[1]) && !['do', 'does', 'did'].includes(q[1]) && d.includes(q[1])) ops.push('auxiliary_inversion_undone');
  if (q[0] === 'how' && ['many', 'much'].includes(q[1])) ops.push('quantity_slot_filled');
  if (/\b(was|were|is|are|been)\b [\p{L}]+(ed|en)\b by\b/u.test(declarative)) ops.push('passive_declarative');
  if (['in', 'on', 'at', 'during', 'from', 'by', 'for'].includes(d[index - 1])) ops.push('answer_in_prepositional_phrase');
  if (AUX.has(q[0])) ops.push('yes_no_to_statement');
  const ratio = d.length / Math.max(1, q.length);
  return { ops: ops.length ? ops : ['other_rewrite'], position, ratio };
}

// ---------------------------------------------------------------- miner
function topSkeletons(map, limit = 12) {
  return Object.fromEntries(Object.entries(map).map(([type, skeletons]) => [type, Object.entries(skeletons).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([pattern, count]) => ({ pattern, count }))]));
}
const bandOf = n => n <= 5 ? '1-5' : n <= 10 ? '6-10' : n <= 15 ? '11-15' : n <= 25 ? '16-25' : n <= 40 ? '26-40' : '41+';

export async function mine({ limit = Infinity } = {}) {
  const started = performance.now();
  const inv = { question_types: {}, question_skeletons: {}, discourse: {}, noise: {}, paraphrase: {}, length_bands: {}, typos: null, ambiguity: null, reasoning: null, declarative: null };
  const tally = (section, source) => (inv[section][source] ??= {});
  const qqpFreq = new Map();

  const observeQuestion = (source, text) => {
    const type = questionType(text);
    bump(tally('question_types', source), type);
    const skeletons = (inv.question_skeletons[source] ??= {});
    bump((skeletons[type] ??= {}), maskStructure(text));
    for (const form of discourseForms(text)) bump(tally('discourse', source), form);
    for (const feature of noiseFeatures(text)) bump(tally('noise', source), feature);
    bump(tally('noise', source), '_texts');
    bump(tally('length_bands', source), bandOf(words(text).length));
  };

  // QQP: both questions of every pair; pair label; paraphrase operations by label; token frequencies for typos.
  const qqpOps = { same: {}, different: {} }, qqpLabels = {};
  const qqpJaccard = { same: {}, different: {} };
  for (const split of ['train', 'validation']) for await (const row of jsonl(path.join(sources, 'qqp', `${split}.jsonl`), limit)) {
    const label = Number(row.label) === 1 ? 'same' : 'different';
    bump(qqpLabels, label);
    for (const text of [row.question1, row.question2]) {
      observeQuestion('qqp', text);
      for (const token of words(text)) qqpFreq.set(token, (qqpFreq.get(token) ?? 0) + 1);
    }
    for (const op of paraphraseOperations(row.question1, row.question2)) bump(qqpOps[label], op);
    bump(qqpJaccard[label], (Math.floor(jaccard(words(row.question1), words(row.question2)) * 5) / 5).toFixed(1));
  }
  inv.paraphrase.qqp = { labels: qqpLabels, operations_by_label: { same: sortTally(qqpOps.same), different: sortTally(qqpOps.different) }, token_jaccard_bands: qqpJaccard };

  // PAWS: clean Wikipedia baseline for noise; high-overlap contrast operations.
  const pawsOps = { same: {}, different: {} }, pawsLabels = {}, pawsJaccard = { same: {}, different: {} };
  for (const split of ['train', 'validation']) for await (const row of jsonl(path.join(sources, 'paws', `${split}.jsonl`), limit)) {
    const label = Number(row.label) === 1 ? 'same' : 'different';
    bump(pawsLabels, label);
    for (const text of [row.sentence1, row.sentence2]) {
      for (const feature of noiseFeatures(text)) bump(tally('noise', 'paws'), feature);
      bump(tally('noise', 'paws'), '_texts');
      bump(tally('length_bands', 'paws'), bandOf(words(text).length));
    }
    for (const op of paraphraseOperations(row.sentence1, row.sentence2)) bump(pawsOps[label], op);
    bump(pawsJaccard[label], (Math.floor(jaccard(words(row.sentence1), words(row.sentence2)) * 5) / 5).toFixed(1));
  }
  inv.paraphrase.paws = { labels: pawsLabels, operations_by_label: { same: sortTally(pawsOps.same), different: sortTally(pawsOps.different) }, token_jaccard_bands: pawsJaccard };

  // Typo model from QQP: hapax tokens with an edit-distance-1 neighbour among frequent tokens.
  const frequent = [...qqpFreq].filter(([t, n]) => n >= 50 && /^\p{L}+$/u.test(t) && t.length >= 3);
  const index = new Map();
  for (const [token] of frequent) for (const key of deletes(token)) if (!index.has(key)) index.set(key, token);
  const typoOps = {};
  let hapax = 0, typoTokens = 0, totalTokens = 0;
  for (const [token, n] of qqpFreq) {
    totalTokens += n;
    if (n > 1 || !/^\p{L}+$/u.test(token) || token.length < 4) continue;
    hapax++;
    let match = null;
    for (const key of deletes(token)) { const candidate = index.get(key); if (candidate && candidate !== token && editDistance(candidate, token, 1) <= 1) { match = candidate; break; } }
    if (match) { typoTokens++; bump(typoOps, typoOperation(token, match)); }
  }
  inv.typos = { method: 'QQP hapax tokens (length >= 4) within edit distance 1 of a token seen >= 50 times; a lower bound on real typos, lexical heuristic', qqp_token_occurrences: totalTokens, hapax_tokens: hapax, likely_typo_types: typoTokens, likely_typo_type_rate_among_hapax: Number((typoTokens / Math.max(1, hapax)).toFixed(4)), operations: sortTally(typoOps) };

  // QA2D: question types, discourse, declarative rewrite operations.
  const qa2dOps = {}, qa2dPosition = {}, qa2dRatio = {};
  for (const split of ['train', 'dev']) for await (const row of jsonl(path.join(sources, 'qa2d', `${split}.jsonl`), limit)) {
    observeQuestion('qa2d', row.question);
    const rewrite = declarativeRewrite(row.question, row.answer ?? '', row.turker_answer ?? row['rule-based'] ?? '');
    for (const op of rewrite.ops) bump(qa2dOps, op);
    bump(qa2dPosition, rewrite.position);
    if (rewrite.ratio !== null) bump(qa2dRatio, rewrite.ratio < 1 ? '<1.0' : rewrite.ratio < 1.25 ? '1.0-1.25' : rewrite.ratio < 1.5 ? '1.25-1.5' : rewrite.ratio < 2 ? '1.5-2.0' : '>=2.0');
  }
  inv.declarative = { source: 'qa2d', operations: sortTally(qa2dOps), answer_position: sortTally(qa2dPosition), declarative_to_question_length_ratio: qa2dRatio };

  // AmbigNQ: ambiguity operations between the original and each disambiguated rewrite.
  const amb = { questions: 0, single_answer: 0, multiple_qa: 0, interpretations_per_multiple_qa: {}, operations: {}, operation_sets: {} };
  for (const split of ['train', 'dev']) {
    const file = path.join(sources, 'ambignq', `${split}.json`);
    if (!fs.existsSync(file)) continue;
    let n = 0;
    for (const row of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (n++ >= limit) break;
      amb.questions++;
      observeQuestion('ambignq', row.question);
      for (const annotation of row.annotations ?? []) {
        if (annotation.type === 'singleAnswer') { amb.single_answer++; continue; }
        amb.multiple_qa++;
        bump(amb.interpretations_per_multiple_qa, String(Math.min(annotation.qaPairs?.length ?? 0, 6)));
        const seen = new Set();
        for (const pair of annotation.qaPairs ?? []) for (const op of ambiguityOperation(row.question, pair.question)) seen.add(op);
        for (const op of seen) bump(amb.operations, op);
        bump(amb.operation_sets, [...seen].sort().join('+'));
      }
    }
  }
  amb.operations = sortTally(amb.operations);
  amb.operation_sets = sortTally(amb.operation_sets, 15);
  amb.taxonomy_note = 'Operations are lexical proxies for the AmbigNQ categories (event reference, property, entity reference, answer type, time dependency); counted once per multiple-QA annotation.';
  inv.ambiguity = amb;

  // ProofWriter: depth, status, polarity, rule forms (masked), families.
  const pw = { theories: 0, by_family: {}, theory_depth: {}, questions: 0, status: {}, status_by_qdep: {}, question_polarity: {}, strategies: {}, fact_polarity: {}, rule_body_sizes: {}, rules_with_negated_body: 0, rules_with_negated_head: 0, rules: 0, rule_forms: {}, relation_kinds: {} };
  for (const split of ['train', 'validation', 'test']) for await (const row of jsonl(path.join(sources, 'proofwriter-structured', `OWA-${split}.jsonl`), limit)) {
    pw.theories++;
    bump(pw.by_family, row.family ?? 'unknown');
    bump(pw.theory_depth, String(row.depth));
    for (const fact of row.facts ?? []) { bump(pw.fact_polarity, fact.polarity); bump(pw.relation_kinds, fact.relation === 'is' ? 'attribute' : 'relation'); }
    for (const rule of row.rules ?? []) {
      pw.rules++;
      bump(pw.rule_body_sizes, String(rule.premises?.length ?? 0));
      if ((rule.premises ?? []).some(p => p.polarity === '-' || p.polarity === '~')) pw.rules_with_negated_body++;
      if (rule.conclusion?.polarity === '-' || rule.conclusion?.polarity === '~') pw.rules_with_negated_head++;
      bump(pw.rule_forms, maskStructure(rule.text));
    }
    for (const q of row.questions ?? []) {
      pw.questions++;
      bump(pw.status, q.answer);
      bump((pw.status_by_qdep[String(q.qdep)] ??= {}), q.answer);
      bump(pw.question_polarity, q.query?.polarity ?? 'unknown');
      bump(pw.strategies, q.strategy ?? 'unknown');
    }
  }
  pw.rule_forms = Object.entries(pw.rule_forms).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pattern, count]) => ({ pattern, count }));
  pw.note = 'Rule forms are masked skeletons (closed-class words kept, the synthetic attribute and name vocabulary masked). "~" and "-" are formal polarity markers.';
  inv.reasoning = pw;

  inv.question_skeletons = Object.fromEntries(Object.entries(inv.question_skeletons).map(([source, map]) => [source, topSkeletons(map, 8)]));
  for (const section of ['question_types', 'discourse', 'noise', 'length_bands']) for (const source of Object.keys(inv[section])) inv[section][source] = sortTally(inv[section][source]);
  inv.elapsed_ms = Math.round(performance.now() - started);
  return inv;
}

export async function buildInventory({ limit = Infinity } = {}) {
  const mined = await mine({ limit });
  const rate = (tally, key) => Number(((tally[key] ?? 0) / Math.max(1, tally._texts ?? 1)).toFixed(4));
  const noiseRates = Object.fromEntries(Object.entries(mined.noise).map(([source, tally]) => [source, Object.fromEntries(Object.keys(tally).filter(k => k !== '_texts').map(k => [k, rate(tally, k)]))]));
  return {
    format: 'chatsop-diversity-inventory-v1',
    generated_by: 'node tools/datasets/diversity/mine-sources.mjs',
    generated_on: new Date().toISOString().slice(0, 10),
    rights: manifestRights(['qqp', 'paws', 'proofwriter', 'ambignq', 'qa2d', 'squad']),
    method: 'Deterministic lexical heuristics over the cached source files in datasets_sources/. Counts are measurements of surface phenomena, not semantic annotations. Skeletons keep closed-class words and mask every content word as X and numbers as N; no source sentence, name, answer or id is stored.',
    row_limit_per_file: Number.isFinite(limit) ? limit : null,
    sources_mined: {
      question_types: ['qqp (both questions)', 'qa2d (questions)', 'ambignq (original questions)'],
      paraphrase_operations: ['qqp pairs', 'paws pairs'], ambiguity_types: ['ambignq multiple-QA annotations'],
      reasoning: ['proofwriter OWA train/validation/test'], declarative_rewrites: ['qa2d train/dev'], noise: ['qqp', 'paws (clean baseline)', 'qa2d', 'ambignq'],
    },
    question_types: mined.question_types,
    question_skeletons: mined.question_skeletons,
    discourse_forms: mined.discourse,
    length_bands_tokens: mined.length_bands,
    paraphrase_operations: mined.paraphrase,
    ambiguity_types: mined.ambiguity,
    reasoning_depth_and_negation: mined.reasoning,
    declarative_rewrites: mined.declarative,
    noise_rates: noiseRates,
    typo_model_measured: mined.typos,
    authored: authoredSummary({ noiseRates, typos: mined.typos }),
    mining_elapsed_ms: mined.elapsed_ms,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
  const limit = value('limit') ? Number(value('limit')) : Infinity;
  const out = path.resolve(value('out') ?? path.join(root, 'tools/datasets/diversity/inventory/inventory.json'));
  const inventory = await buildInventory({ limit });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(inventory, null, 2) + '\n');
  console.log(`inventory -> ${path.relative(process.cwd(), out)} (${inventory.mining_elapsed_ms} ms)`);
}
