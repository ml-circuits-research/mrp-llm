/**
 * KBQA benchmarks (tools/eval/kbqa/cli.mjs): loaders for the cached public sources under datasets_sources/kbqa/<name>/ (gitignored),
 * the question-type classifier and the seeded stratified sample written to the sealed suite eval/suites/kbqa-<name>/test.jsonl.
 *
 * Every row: {id, benchmark, source_id, question, type, native_type, entities: [Qid], properties: [Pid], sparql|null,
 * gold: {kind, answers: [...]} | null (filled from WDQS by gold.mjs when the source carries no answer), license, source}.
 * The rows are evaluation material only: no generator or training code reads them (AGENTS.md rule 9, eval/leakage.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CACHE = path.join(ROOT, 'datasets_sources', 'kbqa');
export const suiteFile = name => path.join(ROOT, 'eval', 'suites', `kbqa-${name}`, 'test.jsonl');

/** The owner's strata (simple, count, comparative, superlative, yesno, multihop, intersection) plus the native extras some benchmarks label. */
export const TYPES = ['simple', 'count', 'comparative', 'superlative', 'yesno', 'multihop', 'intersection', 'ordinal', 'difference', 'qualifier', 'string_filter'];

export const BENCHMARKS = {
  mintaka: {
    title: 'Mintaka (Amazon Science), test split', url: 'https://github.com/amazon-science/mintaka', license: 'CC-BY-4.0',
    citation: 'Sen, Aji, Saffari. Mintaka: A Complex, Natural, and Multilingual Dataset for End-to-End Question Answering. COLING 2022.',
    files: {'mintaka_test.json': 'https://raw.githubusercontent.com/amazon-science/mintaka/main/data/mintaka_test.json', 'LICENSE.md': 'https://raw.githubusercontent.com/amazon-science/mintaka/main/LICENSE.md'},
  },
  lcquad2: {
    title: 'LC-QuAD 2.0, test split', url: 'https://github.com/AskNowQA/LC-QuAD2.0 (figshare 7982858)', license: 'CC-BY-4.0 (figshare record; the Hugging Face card states CC-BY-3.0)',
    citation: 'Dubey, Banerjee, Abdelkawi, Lehmann. LC-QuAD 2.0: A Large Dataset for Complex Question Answering over Wikidata and DBpedia. ISWC 2019.',
    files: {'test.json': 'https://raw.githubusercontent.com/AskNowQA/LC-QuAD2.0/master/dataset/test.json'},
  },
  simplequestions: {
    title: 'SimpleQuestions-Wikidata (answerable test)', url: 'https://github.com/askplatypus/wikidata-simplequestions', license: 'CC-BY-3.0',
    citation: 'Diefenbach, Pellissier Tanon, Singh, Maret. Question Answering Benchmarks for Wikidata. ISWC 2017 (Posters & Demos); SimpleQuestions: Bordes et al. 2015.',
    files: {'annotated_wd_data_test_answerable.txt': 'https://raw.githubusercontent.com/askplatypus/wikidata-simplequestions/master/annotated_wd_data_test_answerable.txt', 'LICENSE.txt': 'https://raw.githubusercontent.com/askplatypus/wikidata-simplequestions/master/LICENSE.txt'},
  },
  qald10: {
    title: 'QALD-10 test (Wikidata)', url: 'https://github.com/KGQA/QALD-10', license: 'MIT',
    citation: 'Usbeck et al. QALD-10 — The 10th Challenge on Question Answering over Linked Data. Semantic Web Journal 2023.',
    files: {'qald_10.json': 'https://raw.githubusercontent.com/KGQA/QALD-10/main/data/qald_10/qald_10.json', 'LICENSE': 'https://raw.githubusercontent.com/KGQA/QALD-10/main/LICENSE'},
  },
};

/** Downloads the source files of a benchmark into its cache folder (once). */
export async function download(name) {
  const dir = path.join(CACHE, name);
  fs.mkdirSync(dir, {recursive: true});
  for (const [file, url] of Object.entries(BENCHMARKS[name].files)) {
    const target = path.join(dir, file);
    if (fs.existsSync(target) && fs.statSync(target).size > 100) continue;
    const res = await fetch(url, {headers: {'User-Agent': 'ChatSOP-kbqa'}});
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }
}

const QID = /\bwd:(Q\d+)\b/g;
const PID = /\b(?:wdt|p|ps|pq):(P\d+)\b/g;
const uniq = list => [...new Set(list)];
export const sparqlEntities = q => uniq([...q.matchAll(QID)].map(m => m[1]));
export const sparqlProperties = q => uniq([...q.matchAll(PID)].map(m => m[1]));

/**
 * The question type from a gold SPARQL query (LC-QuAD 2.0, QALD-10): ASK is yesno, COUNT count, ORDER BY with LIMIT superlative,
 * a qualifier (p:/ps:/pq:) qualifier, a string FILTER string_filter, a numeric comparison FILTER comparative; otherwise the triple
 * patterns decide: a variable that links two patterns (neither of them the answer's type) is multihop, two or more constraints on the
 * answer intersection, else simple (one pattern, optionally typed with P31).
 */
export function sparqlType(raw) {
  const q = raw.replace(/PREFIX\s+\S+\s+<[^>]*>/gi, ' ').replace(/\s+/g, ' ');
  if (/^\s*ASK\b/i.test(q) || /\bASK\s*(WHERE)?\s*\{/i.test(q)) return 'yesno';
  if (/\bCOUNT\s*\(/i.test(q)) return 'count';
  if (/\bORDER\s+BY\b/i.test(q) && /\bLIMIT\b/i.test(q)) return 'superlative';
  if (/\b(?:p|ps|pq):P\d+/.test(q)) return 'qualifier';
  if (/FILTER\s*\(\s*(?:CONTAINS|STRSTARTS|REGEX|LANG)/i.test(q)) return 'string_filter';
  if (/FILTER\s*\([^)]*[<>]/.test(q)) return 'comparative';
  const body = q.slice(q.indexOf('{') + 1, q.lastIndexOf('}')).replace(/[{}]/g, ' ').replace(/(\S)\.(\s|$)/g, '$1 . ').replace(/\bOPTIONAL\b|\bUNION\b|\bMINUS\b|\bSERVICE\b[^.]*/gi, ' ');
  const triples = body.replace(/FILTER\s*\([^)]*\)/gi, ' ').split(/\s\.\s|\s\.$|;\s/).map(t => t.trim().split(/\s+/)).filter(t => t.length >= 3 && /:/.test(t[1]));
  const select = (q.match(/SELECT\s+(?:DISTINCT\s+)?(\?\w+)/i) ?? [])[1];
  const content = triples.filter(t => t[1] !== 'wdt:P31' && t[1] !== 'wdt:P279');
  if (content.length <= 1) return 'simple';
  const vars = new Map();
  for (const t of content) for (const term of [t[0], t[2]]) if (term?.startsWith('?')) vars.set(term, (vars.get(term) ?? 0) + 1);
  const bridge = [...vars].some(([v, n]) => v !== select && n >= 2);
  return bridge ? 'multihop' : 'intersection';
}

const MINTAKA_TYPE = {generic: 'simple', count: 'count', comparative: 'comparative', superlative: 'superlative', yesno: 'yesno', multihop: 'multihop', intersection: 'intersection', ordinal: 'ordinal', difference: 'difference'};

/** A Wikidata JSON-results binding value -> a gold answer item. */
export function answerOf(value, datatype = null) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('http://www.wikidata.org/entity/Q')) return {kind: 'entity', qid: value.slice(31)};
  if (/^(true|false)$/.test(value) && (!datatype || /boolean/.test(datatype))) return {kind: 'boolean', value: value === 'true'};
  if (/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)) return {kind: 'number', value: Number(value)};
  if (/^-?\d{4,}-\d\d-\d\dT/.test(value)) return {kind: 'date', value: value.slice(0, 10).replace(/-00-00$|-01-01$/, m => m)};
  return {kind: 'string', value};
}

function loadMintaka() {
  const data = JSON.parse(fs.readFileSync(path.join(CACHE, 'mintaka', 'mintaka_test.json'), 'utf8'));
  return data.map(r => {
    const a = r.answer ?? {};
    let answers = [];
    if (a.answerType === 'entity') answers = (a.answer ?? []).map(e => ({kind: 'entity', qid: e.name, label: e.label?.en ?? null}));
    else if (a.answerType === 'numerical') answers = (a.answer ?? []).map(v => ({kind: 'number', value: Number(v)}));
    else if (a.answerType === 'boolean') answers = (a.answer ?? []).map(v => ({kind: 'boolean', value: v === true || v === 'True' || v === 'true'}));
    else if (a.answerType === 'date') answers = (a.answer ?? []).map(v => ({kind: 'date', value: String(v)}));
    else answers = (a.answer ?? []).map(v => ({kind: 'string', value: String(v)}));
    return {source_id: r.id, question: r.question, native_type: r.complexityType, type: MINTAKA_TYPE[r.complexityType] ?? 'simple', category: r.category,
      entities: uniq((r.questionEntity ?? []).filter(e => e.entityType === 'entity' && /^Q\d+$/.test(e.name)).map(e => e.name)),
      mentions: (r.questionEntity ?? []).filter(e => e.entityType === 'entity').map(e => ({qid: e.name, mention: e.mention})),
      properties: [], sparql: null, gold: {kind: a.answerType ?? 'string', answers, mention: a.mention ?? null}};
  }).filter(r => r.gold.answers.length);
}

function loadLcquad() {
  const data = JSON.parse(fs.readFileSync(path.join(CACHE, 'lcquad2', 'test.json'), 'utf8'));
  return data.map(r => {
    const paraphrase = typeof r.paraphrased_question === 'string' ? r.paraphrased_question.trim() : '';
    // The paraphrase is the natural question; rows whose paraphrase is missing or a copy of the template fall back to the verbalized question.
    const question = paraphrase.length > 10 && !/[{}]/.test(paraphrase) ? paraphrase : (typeof r.question === 'string' ? r.question.trim() : '');
    return {source_id: String(r.uid), question, native_type: String(r.subgraph ?? r.template_id), type: sparqlType(r.sparql_wikidata),
      entities: sparqlEntities(r.sparql_wikidata), properties: sparqlProperties(r.sparql_wikidata), sparql: r.sparql_wikidata.trim(), gold: null,
      question_origin: question === paraphrase ? 'paraphrased_question' : 'question'};
  }).filter(r => r.question && !/[{}]/.test(r.question) && r.question.length < 300);
}

function loadSimpleQuestions() {
  const lines = fs.readFileSync(path.join(CACHE, 'simplequestions', 'annotated_wd_data_test_answerable.txt'), 'utf8').split('\n').filter(Boolean);
  return lines.map((line, i) => {
    const [s, p, o, question] = line.split('\t');
    const inverse = p.startsWith('R');
    const pid = 'P' + p.slice(1);
    // Rxxx is the inverse of Pxxx: the question asks for the subject of "?x Pxxx o".
    const sparql = inverse ? `SELECT DISTINCT ?x WHERE { ?x wdt:${pid} wd:${s} . }` : `SELECT DISTINCT ?x WHERE { wd:${s} wdt:${pid} ?x . }`;
    return {source_id: `test-${i}`, question: question.trim().replace(/\s+/g, ' '), native_type: inverse ? 'simple-inverse' : 'simple', type: 'simple',
      entities: [s], properties: [pid], sparql, gold: null, gold_triple: [s, p, o]};
  }).filter(r => r.question.length > 5);
}

function loadQald10() {
  const data = JSON.parse(fs.readFileSync(path.join(CACHE, 'qald10', 'qald_10.json'), 'utf8'));
  return data.questions.map(r => {
    const question = (r.question.find(q => q.language === 'en')?.string ?? '').trim();
    const sparql = r.query?.sparql ?? '';
    const res = r.answers?.[0] ?? {};
    let answers = [];
    if (typeof res.boolean === 'boolean') answers = [{kind: 'boolean', value: res.boolean}];
    else for (const b of res.results?.bindings ?? []) for (const v of Object.values(b)) { const a = answerOf(v.value, v.datatype); if (a) answers.push(a); }
    const kind = answers[0]?.kind ?? 'entity';
    return {source_id: String(r.id), question, native_type: sparqlType(sparql), type: sparqlType(sparql), entities: sparqlEntities(sparql), properties: sparqlProperties(sparql),
      sparql, gold: {kind, answers}};
  }).filter(r => r.question && r.gold.answers.length);
}

export const LOADERS = {mintaka: loadMintaka, lcquad2: loadLcquad, simplequestions: loadSimpleQuestions, qald10: loadQald10};

/** Deterministic seeded order: sha256(seed + key). */
const rank = (seed, key) => createHash('sha256').update(`${seed}:${key}`).digest('hex');

/**
 * The stratified sample: up to `size` rows, quota per type proportional to an equal share (a type with fewer rows gives its unused share to the others),
 * ordered so that every prefix (the 100 and 300 stages) is itself stratified: the strata are interleaved round-robin in seeded order.
 */
export function stratifiedSample(rows, {size = 1000, seed = 'kbqa-v1'} = {}) {
  const byType = new Map();
  for (const r of [...rows].sort((a, b) => rank(seed, a.source_id).localeCompare(rank(seed, b.source_id)))) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)).push(r);
  const types = [...byType.keys()].sort();
  const quota = new Map(types.map(t => [t, 0]));
  let left = Math.min(size, rows.length);
  while (left > 0) {
    const open = types.filter(t => quota.get(t) < byType.get(t).length);
    if (!open.length) break;
    for (const t of open) { if (left <= 0) break; quota.set(t, quota.get(t) + 1); left--; }
  }
  const out = [];
  for (let i = 0; out.length < [...quota.values()].reduce((a, b) => a + b, 0); i++) for (const t of types) if (i < quota.get(t)) out.push(byType.get(t)[i]);
  return out;
}
