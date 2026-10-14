#!/usr/bin/env node
/**
 * The capability inventory (owner request 2026-10-02, the "no capability loss" battery): every capability of SOP Lang derived
 * MECHANICALLY from the grammar tables and the contracts, so that a new wire type, field, enum value, word or validator rule appears
 * here, and in the coverage report as uncovered, without anyone writing it down:
 *
 *   knowledge surface   sop/knowledge/grammar.mjs GRAMMAR (types, fields, enum values), the condition leaves and words of sop/enums.mjs,
 *                       the method step blocks, the term kinds, the strategy FEATURES, and the validator's problem codes (sop/knowledge/*.mjs)
 *   model surface       sop/parser.mjs SPEC restricted to the formalizer's types (sop/declarative.mjs MODEL_TYPES), sop/enums.mjs ENUMS,
 *                       roles, polarities, link keywords, the words of compare/rank/quantifier/order/constraint lines, session definitions,
 *                       and the admission codes of sop/parser.mjs and sop/declarative.mjs
 *   FOL converter       the fol-v3 line forms (SUPPOSE, ASSUME), the support questions of lib/formalize/fol/to-sop.mjs META_KINDS and
 *                       the effect classes of sop/enums.mjs EFFECT_CLASSES (tools/capabilities/l1-fol.mjs)
 *   combinations        the pairs of capability families of `PAIRS` (program level: both tags in one program) and the LOCAL cells
 *                       the tagger reads from one construct (`LOCAL`), each expanded from the current enumerations
 *
 * Every capability says at which layers it is measured: L1 (parsing and validation), L2 (execution: every engine against the oracle),
 * L3 (formalization: message, circuit, answer).
 *
 *   node tools/capabilities/inventory.mjs [--write]      prints a summary; --write writes eval/capabilities/capabilities.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GRAMMAR, FEATURES, STEP_BLOCKS} from '../../sop/knowledge/grammar.mjs';
import {SPEC} from '../../sop/parser.mjs';
import {MODEL_TYPES} from '../../sop/declarative.mjs';
import {EXPRESSION_FUNCTIONS, EXPRESSION_MATH, EXPRESSION_STRING_METHODS, EXPRESSION_ARRAY_METHODS} from '../../sop/expression.mjs';
import {enumValues} from './checks.mjs';
import {folCapabilities} from './l1-fol.mjs';
import {ENUMS, COMPARATOR_WORDS, ARITHMETIC_WORDS, COMPUTE_WORDS, ORDER_WORDS, QUANTIFIER_WORDS, RANK_WORDS, RANK_CUTS, ORDER_SAMPLING, LINK_WORDS, ROLE_NAMES, POLARITIES, CERTAINTIES, QUERY_MODES as MODEL_QUERY_MODES, REASONING_QUERY_MODES} from '../../sop/enums.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const OUT = path.join(ROOT, 'eval/capabilities/capabilities.json');

/** Knowledge wire types the generated L2 programs execute (the relational core and its question forms). */
export const L2_TYPES = ['predicate', 'fact', 'rule', 'default', 'integrity', 'aggregate', 'query', 'hypothesis', 'constraint', 'policy'];
/** Model-surface fields that are host plumbing or bookkeeping, never something a user message needs. */
const NOT_L3 = new Set(['span', 'source', 'score', 'basis', 'language', 'near', 'speaker']);
const SESSION_TYPES = ['predicate', 'rule', 'default', 'aggregate'];
const AGG_FUNCTIONS = ['count', 'sum', 'min', 'max', 'collect'];
const TIME_QUERY_FIELDS = ['at', 'during', 'overlaps', 'asof'];
const QUERY_FORMS = ['compare', 'rank', 'limit', 'except', 'quantifier', 'order'];

/** Validator problem codes, read from the validator sources (the strings they push), so a new rule appears as a capability. */
function problemCodes(files, pattern) {
  const codes = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(pattern)) if (m[1].includes('_')) codes.add(m[1]);
  }
  return [...codes].sort();
}
const dir = d => fs.readdirSync(path.join(ROOT, d)).filter(f => f.endsWith('.mjs')).map(f => d + '/' + f);

/** The capability families of the combination grid: name -> tag ids, expanded from the current tables. */
export function families() {
  // the modes of work (plan, conform, procedure) run over actions, methods, norms and traces; they pair with the relational
  // constructs only through the planner's own smoke cases, so the grid pairs the question modes over relational programs
  const modes = GRAMMAR.query.fields.mode.values.filter(m => !['plan', 'conform', 'procedure'].includes(m));
  return {
    mode: modes.map(m => 'k.enum.query.mode.' + m),
    aggregate: AGG_FUNCTIONS.map(f => 'k.field.aggregate.' + f),
    negation: ['k.leaf.not', 'k.leaf.absent'],
    default: ['k.field.default.except', 'k.field.default.priority', 'k.field.default.overrides'],
    time: [...TIME_QUERY_FIELDS.map(f => 'k.field.query.' + f), 'k.field.fact.valid', 'k.leaf.start_of', 'k.leaf.end_of', ...ORDER_WORDS.map(w => 'k.leaf.order.' + w)],
    quantifier: QUANTIFIER_WORDS.map(w => 'k.word.query.quantifier.' + w),
    compute: COMPUTE_WORDS.map(w => 'k.leaf.compute.' + w),
    compare: Object.keys(COMPARATOR_WORDS).map(w => 'k.leaf.compare.' + w),
    recursion: ['k.feature.recursion'],
    decimal: ['k.term.decimal'],
    integrity: ['k.wire.integrity'],
    supposition: ['k.field.query.if', 'k.enum.fact.status.supposed'],
    group: ['k.group.all', 'k.group.any'],
    query_form: QUERY_FORMS.map(f => 'k.field.query.' + f)
  };
}

/** Program-level pairs: a cell is covered by a program that carries one tag of each family (for a family with itself, two distinct tags). */
export const PAIRS = [
  ['mode', 'aggregate'], ['mode', 'negation'], ['mode', 'time'], ['mode', 'recursion'], ['mode', 'default'], ['mode', 'query_form'], ['mode', 'integrity'], ['mode', 'supposition'], ['mode', 'decimal'],
  ['negation', 'recursion'], ['negation', 'aggregate'], ['negation', 'time'], ['negation', 'group'], ['negation', 'supposition'],
  ['default', 'default'], ['default', 'integrity'], ['default', 'negation'], ['default', 'supposition'], ['default', 'recursion'],
  ['time', 'quantifier'], ['time', 'aggregate'], ['time', 'recursion'],
  ['compute', 'aggregate'], ['aggregate', 'recursion'], ['aggregate', 'decimal'], ['compare', 'decimal'], ['integrity', 'negation'], ['supposition', 'recursion']
];

/**
 * Pairs the language excludes by contract (an L1 question, not a combination to execute): a quantifier belongs to `mode every`, the
 * value forms (compare, rank, limit, except, order) to the row-returning modes, and the proof modes (explain, why_not, abduce) take
 * none of them.
 */
export function meaningfulPair(a, b) {
  const mode = [a, b].find(t => t.startsWith('k.enum.query.mode.'))?.slice('k.enum.query.mode.'.length);
  const other = mode ? [a, b].find(t => !t.startsWith('k.enum.query.mode.')) : null;
  if (mode && other?.startsWith('k.field.query.')) {
    const form = other.slice('k.field.query.'.length);
    if (form === 'quantifier') return mode === 'every';
    if (['compare', 'rank', 'limit', 'except', 'order'].includes(form)) return ['select', 'count'].includes(mode) || (mode === 'exists' && form !== 'limit');
  }
  return true;
}

/** Local cells: the tagger reads them from one construct (`x.A×B.a.b`, tools/capabilities/tags.mjs). */
export function localCells() {
  return {
    'negation×closedness': [['not', 'absent'], ['closed', 'open']],
    'compute×number': [[...COMPUTE_WORDS], ['integer', 'decimal']],
    'compute×recursion': [[...COMPUTE_WORDS], ['recursive']],
    'link×certainty': [[...LINK_WORDS], [...CERTAINTIES, 'assumed']]
  };
}

/** The local cells that are invalid by contract (an L1 negative, never executed). */
export const INVALID_LOCAL = new Set(['x.negation×closedness.absent.open', ...LINK_WORDS.filter(w => ['if', 'unless', 'so_that'].includes(w)).flatMap(w => ['asserted', 'hedged', 'assumed'].map(c => `x.link×certainty.${w}.${c}`))]);

export function buildInventory() {
  const caps = [];
  const add = (id, surface, kind, layers, extra = {}) => caps.push({id, surface, kind, layers, ...extra});
  // ---------------------------------------------------------------- knowledge surface
  for (const [type, g] of Object.entries(GRAMMAR)) {
    const l2 = L2_TYPES.includes(type);
    add('k.wire.' + type, 'knowledge', 'wire', l2 ? ['L1', 'L2'] : ['L1'], {doc: g.doc});
    for (const [field, spec] of Object.entries(g.fields)) {
      add(`k.field.${type}.${field}`, 'knowledge', 'field', l2 ? ['L1', 'L2'] : ['L1'], {card: spec.card, required: Boolean(spec.required), valueKind: spec.kind});
      if (spec.values) for (const v of spec.values) add(`k.enum.${type}.${field}.${v}`, 'knowledge', 'enum', l2 ? ['L1', 'L2'] : ['L1']);
      if (spec.kind === 'bool') for (const v of ['true', 'false']) add(`k.enum.${type}.${field}.${v}`, 'knowledge', 'enum', l2 ? ['L1', 'L2'] : ['L1']);
    }
  }
  for (const v of GRAMMAR.fact.fields.status.values) if (!caps.some(c => c.id === 'k.enum.fact.status.' + v)) add('k.enum.fact.status.' + v, 'knowledge', 'enum', ['L1', 'L2']);
  for (const leaf of ['atom', 'not', 'absent', 'start_of', 'end_of', 'match']) add('k.leaf.' + leaf, 'knowledge', 'leaf', leaf === 'match' ? ['L1'] : ['L1', 'L2']);
  for (const w of Object.keys(COMPARATOR_WORDS)) add('k.leaf.compare.' + w, 'knowledge', 'leaf', ['L1', 'L2']);
  for (const w of COMPUTE_WORDS) add('k.leaf.compute.' + w, 'knowledge', 'leaf', ['L1', 'L2']);
  for (const w of ORDER_WORDS) add('k.leaf.order.' + w, 'knowledge', 'leaf', ['L1', 'L2']);
  for (const g of ['all', 'any']) add('k.group.' + g, 'knowledge', 'group', ['L1', 'L2']);
  for (const b of [...STEP_BLOCKS, 'optional', 'achieve', 'pick']) add('k.step.' + b, 'knowledge', 'step', ['L1']);
  for (const t of ['decimal', 'string', 'zero_arity']) add('k.term.' + t, 'knowledge', 'term', ['L1', 'L2']);
  for (const w of QUANTIFIER_WORDS) add('k.word.query.quantifier.' + w, 'knowledge', 'word', ['L1', 'L2']);
  for (const w of RANK_WORDS) add('k.word.query.rank.' + w, 'knowledge', 'word', ['L1', 'L2']);
  for (const w of Object.keys(COMPARATOR_WORDS)) add('k.word.query.compare.' + w, 'knowledge', 'word', ['L1', 'L2']);
  for (const w of ORDER_SAMPLING) add('k.word.query.order.' + w, 'knowledge', 'word', ['L1', 'L2']);
  for (const f of [...FEATURES, 'nonlinear_recursion']) add('k.feature.' + f, 'knowledge', 'feature', ['L2']);
  for (const code of problemCodes(dir('sop/knowledge'), /(?:(?:push|add|err|bad)\(\s*'|code:\s*')([a-z][a-z_]+)'/g)) add('k.check.' + code, 'knowledge', 'check', ['L1']);
  // ---------------------------------------------------------------- model surface (what the formalizer writes)
  const l3Field = (type, field) => !NOT_L3.has(field) ? ['L1', 'L3'] : ['L1'];
  for (const type of MODEL_TYPES) {
    const s = SPEC[type];
    add('m.wire.' + type, 'model', 'wire', ['L1', 'L3']);
    for (const field of [...(s.one ?? []), ...(s.many ?? [])]) {
      add(`m.field.${type}.${field}`, 'model', 'field', l3Field(type, field), {card: (s.one ?? []).includes(field) ? 'one' : 'many', required: (s.required ?? []).includes(field)});
      for (const v of enumValues(type, field) ?? []) add(`m.enum.${type}.${field}.${v}`, 'model', 'enum', l3Field(type, field));
    }
  }
  for (const t of SESSION_TYPES) add('m.session.' + t, 'model', 'session', ['L1', 'L3']);
  for (const r of ROLE_NAMES) add('m.role.' + r, 'model', 'role', ['L1', 'L3']);
  for (const p of POLARITIES) add('m.polarity.' + p, 'model', 'polarity', ['L1', 'L3']);
  add('m.match', 'model', 'leaf', ['L1', 'L3']);
  for (const g of ['all', 'any']) add('m.group.' + g, 'model', 'group', ['L1', 'L3']);
  for (const w of Object.keys(COMPARATOR_WORDS)) add('m.word.query.compare.' + w, 'model', 'word', ['L1', 'L3']);
  for (const w of [...RANK_WORDS, ...RANK_CUTS]) add('m.word.query.rank.' + w, 'model', 'word', ['L1', 'L3']);
  for (const w of QUANTIFIER_WORDS) add('m.word.query.quantifier.' + w, 'model', 'word', ['L1', 'L3']);
  for (const w of [...ORDER_WORDS, ...ORDER_SAMPLING]) add('m.word.query.order.' + w, 'model', 'word', ['L1', 'L3']);
  for (const w of [...Object.keys(COMPARATOR_WORDS), ...Object.keys(ARITHMETIC_WORDS)]) add('m.word.constraint.' + w, 'model', 'word', ['L1', 'L3']);
  add('m.role_variable.time', 'model', 'role', ['L1', 'L3']);
  for (const code of problemCodes(['sop/parser.mjs', 'sop/declarative.mjs'], /'([a-z]+(?:_[a-z]+)+): /g)) add('m.check.' + code, 'model', 'check', ['L1']);
  // ---------------------------------------------------------------- expression language (jsEval) and the formalizer's jsEval route
  for (const f of EXPRESSION_FUNCTIONS) add('e.fn.' + f, 'expression', 'function', ['L1']);
  for (const f of EXPRESSION_MATH) add('e.math.' + f, 'expression', 'function', ['L1']);
  for (const f of EXPRESSION_STRING_METHODS) add('e.string.' + f, 'expression', 'method', ['L1']);
  for (const f of EXPRESSION_ARRAY_METHODS) add('e.array.' + f, 'expression', 'method', ['L1']);
  add('e.arrow', 'expression', 'function', ['L1']);
  add('j.wire.jsEval', 'js-route', 'wire', ['L1', 'L3']);
  for (const code of problemCodes(['lib/formalize/js-program.mjs'], /\bbad\('(js_[a-z_]+)'/g).concat(['js_unknown_registry_index']).filter((c, i, a) => a.indexOf(c) === i)) add('j.check.' + code, 'js-route', 'check', ['L1']);
  // ---------------------------------------------------------------- the FOL path's converter (fol-v3 line forms, support questions, effect classes)
  for (const id of folCapabilities()) add(id, 'fol', id.split('.')[1], ['L1']);
  // ---------------------------------------------------------------- combinations
  const fam = families();
  const combos = [];
  for (const [a, b] of PAIRS) {
    const A = fam[a], B = fam[b];
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
      if (a === b && j <= i) continue;
      if (!meaningfulPair(A[i], B[j])) continue;
      combos.push({id: `x.${a}×${b}.${short(A[i])}.${short(B[j])}`, scope: 'program', families: [a, b], tags: [A[i], B[j]], layers: ['L2']});
    }
  }
  for (const [name, [A, B]] of Object.entries(localCells())) for (const x of A) for (const y of B) {
    const id = `x.${name}.${x}.${y}`;
    combos.push({id, scope: 'local', families: name.split('×'), tags: [id], layers: INVALID_LOCAL.has(id) ? ['L1'] : name === 'link×certainty' ? ['L1', 'L3'] : ['L1', 'L2'], invalid: INVALID_LOCAL.has(id) || undefined});
  }
  return {
    generated_by: 'node tools/capabilities/inventory.mjs --write',
    sources: ['sop/knowledge/grammar.mjs', 'sop/enums.mjs', 'sop/parser.mjs', 'sop/declarative.mjs', 'sop/expression.mjs (operation tables)', 'lib/formalize/js-program.mjs (jsEval route admission codes)', 'lib/formalize/fol/to-sop.mjs META_KINDS and sop/enums.mjs EFFECT_CLASSES (FOL converter)', 'sop/knowledge/*.mjs (problem codes)', 'reasoning/router/features.mjs (features)'],
    families: fam, pairs: PAIRS, local: Object.keys(localCells()),
    counts: {capabilities: caps.length, combinations: combos.length, knowledge: caps.filter(c => c.surface === 'knowledge').length, model: caps.filter(c => c.surface === 'model').length},
    capabilities: caps, combinations: combos
  };
}

/** The last two segments of a tag, enough to name a combination cell (`k.enum.query.mode.count` -> `mode.count`). */
export function short(tag) { return tag.split('.').slice(-2).join('.'); }

export function loadInventory(file = OUT) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inv = buildInventory();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), {recursive: true});
    fs.writeFileSync(OUT, JSON.stringify(inv, null, 1) + '\n');
  }
  console.log(JSON.stringify({...inv.counts, written: process.argv.includes('--write') ? path.relative(ROOT, OUT) : null}));
}

export {MODEL_QUERY_MODES, REASONING_QUERY_MODES};
