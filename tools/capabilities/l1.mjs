/**
 * L1 of the capability battery: parsing and validation. The cases are GENERATED from the grammar tables, so a new wire type,
 * field or enum value gets cases (or is reported as having no sample) without anyone listing it:
 *
 *   knowledge surface (sop/knowledge GRAMMAR, validated by validateProgram)
 *     positive  per wire type its skeleton; per field the skeleton with the field set to a sample value; per enum value the field set
 *               to that value. Must validate without errors.
 *     negative  per wire type an unknown field (unknown_field); per field of cardinality one the field twice (repeated_field); per
 *               required field the skeleton without it (missing_field); per field a value of the wrong form (the code of its kind).
 *   model surface (sop/parser.mjs SPEC of the formalizer's types, admitted by parse + checkModelProgram + validateGraph)
 *     the same four kinds of case, the expected error read from the admission message.
 *
 * Skeletons and samples are data of this file: the smallest valid circuit around a wire type, and a valid value per field kind or per
 * (type, field) where the value depends on its context. A field or enum value without a sample is reported (`missing`), never skipped
 * silently. Hand-written cases for validator rules (problem codes) live in eval/capabilities/l1-cases.json.
 *
 *   converter (fol-v3)  fixed FOL lines of invented problems read by the FOL reader, lowered by the converters and executed on the product
 *               route, no model (./l1-fol.mjs, eval/capabilities/fol-cases.json): SUPPOSE, ASSUME, Effect, Explain, Missing, Why,
 *               Change, Assumed and every effect class; a form without a case is reported missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {GRAMMAR, GOV} from '../../sop/knowledge/grammar.mjs';
import {SPEC} from '../../sop/parser.mjs';
import {MODEL_TYPES} from '../../sop/declarative.mjs';
import {ENUMS, COMPUTE_WORDS, COMPARATOR_WORDS, ORDER_WORDS} from '../../sop/enums.mjs';
import {validateKnowledge, validateModel, enumValues} from './checks.mjs';
import {runExpression, EXPRESSION_FUNCTIONS, EXPRESSION_MATH, EXPRESSION_STRING_METHODS, EXPRESSION_ARRAY_METHODS} from '../../sop/expression.mjs';
import {readWires, admitJsProgram} from '../../lib/formalize/js-program.mjs';
import {folCases} from './l1-fol.mjs';
import {registryOf} from '../../lib/formalize/expression-program.mjs';
import {ROOT} from './inventory.mjs';

export const EXTRA = path.join(ROOT, 'eval/capabilities/l1-cases.json');

// ------------------------------------------------------------------------------------------------ knowledge surface

/** Context circuits shared by the skeletons: predicates, an action, an old rule, a contrary default, a soft norm, a procedure. */
const CTX = `@p predicate
  args subject:entity
@q predicate
  args subject:entity
@r2 predicate
  args subject:entity object:entity
@val predicate
  args subject:entity object:integer
@cnt predicate
  args subject:entity object:integer
@state predicate
  args subject:entity topic:entity object:rational
@s0 fact
  holds state demo x0 0
@f0 fact
  holds p a
@fv fact
  holds val a 3
@act action
  params ?x
  requires p ?x
  adds q ?x
@act2 action
  params ?x
  requires q ?x
  adds p ?x
@r_old rule
  when p ?x
  then q ?x
@d_other default
  when p ?x
  then not q ?x
@n_other norm
  forbid ~act ?x
  severity soft
  cost 1
@proc procedure
  members $r_old
@prog code
  of prog
  language javascript
  entry f
  body "function f(x) { return x; }"
`;

/** The wire under test is `@w TYPE` with these fields; `role` is the file role of the circuit holding it. */
const SKELETON = {
  predicate: {fields: [['args', 'subject:entity object:entity']]},
  lexeme: {fields: [['of', 'p'], ['language', 'en'], ['form', '"is p"'], ['frame', 'subject']]},
  entity: {fields: [['kind', 'entity'], ['label', 'en "W"']]},
  fact: {fields: [['holds', 'p b']]},
  rule: {fields: [['when', 'p ?x'], ['then', 'q ?x']]},
  default: {fields: [['when', 'p ?x'], ['then', 'q ?x']]},
  integrity: {fields: [['never', 'p ?x'], ['witness', '?x']]},
  reply: {fields: [['situation', 'greet'], ['text', '"Hello."']]},
  aggregate: {fields: [['over', 'r2 ?x ?y'], ['group', '?x'], ['count', '?y as ?c'], ['yields', 'cnt ?x ?c']]},
  constraint: {fields: [['var', '?x int 0 5'], ['require', '?x at_least 1'], ['claim', '?x equal 2'], ['task', 'prove']]},
  action: {fields: [['params', '?x'], ['requires', 'p ?x'], ['adds', 'q ?x']]},
  method: {fields: [['achieves', 'q ?x'], ['step', '~act ?x']]},
  norm: {fields: [['forbid', '~act ?x']]},
  procedure: {fields: [['members', '$r_old']]},
  amendment: {fields: [['of', '$proc'], ['proposed_by', 'user'], ['removes', '$r_old']]},
  argument: {fields: [['for', '$r_old'], ['claim', '"it is cheaper"']]},
  trace: {fields: [['step', '~act a']]},
  goal: {fields: [['where', 'q a']]},
  hypothesis: {fields: [['holds', 'p c']]},
  policy: {fields: [['maxNodes', '100']], role: 'query'},
  stated: {fields: [['relation', '"p"'], ['role', 'subject "a"'], ['polarity', 'affirmed'], ['certainty', 'supposed']], role: 'query'},
  query: {fields: [['where', 'val ?x ?n'], ['select', '?x ?n']], role: 'query'},
  test: {fields: [['of', 'prog'], ['call', '"f(1)"'], ['expect', '"1"']]},
  code: {fields: [['of', 'prog2'], ['language', 'javascript'], ['entry', 'g'], ['body', '"function g() { return 1; }"']]},
  pack: {fields: [['items', '$f0']]}
};

/** A valid sample per field kind; `PATCH` overrides it where the value needs its context or other fields. */
const BY_KIND = {
  bool: 'true', int: '1', posint: '2', text: '"a note"', time: '2020-01-01 open', vars: '?x', sym: 'demo', date: '2026-01-15', instant: '2021-01-01',
  interval: '2020-01-01 2022-01-01', langcode: 'en', langtext: 'en "a label"', phrase: '"is p"', replytext: '"Hi {{answer}}."', ident: 'h', flag: ''
};
/** Field patches: {set: [[field, value]...], remove: [field...], role?}; an array value is a list of alternative patches. */
const PATCH = {
  'predicate.role': {set: [['role', 'subject entity'], ['role', 'object entity']]},
  'predicate.closed': {set: [['closed', 'true']]},
  'predicate.transitive': {set: [['transitive', 'true']]},
  'predicate.inverse': {set: [['inverse', 'r2']]},
  'predicate.key': {set: [['key', '1']]},
  'predicate.reading': {set: [['reading', 'location']]},
  'predicate.describe_rank': {set: [['reading', 'describe'], ['describe_rank', '1']]},
  'predicate.unit': {set: [['unit', '"kg"']]},
  'lexeme.restrict': {set: [['restrict', 'subject entity']]},
  'lexeme.frame': {set: [['frame', 'subject']]},
  'fact.speaker': {set: [['speaker', '"Ann"'], ['status', 'reported']]},
  'fact.valid': {set: [['valid', '2020-01-01 2021-01-01']]},
  'rule.supersedes': {set: [['supersedes', '$r_old'], ['version', '2']]},
  'rule.approval': {set: [['approval', 'approved'], ['approved_by', '"owner"'], ['approved_at', '2026-01-15']]},
  'rule.approved_by': {set: [['approval', 'approved'], ['approved_by', '"owner"'], ['approved_at', '2026-01-15']]},
  'rule.approved_at': {set: [['approval', 'approved'], ['approved_by', '"owner"'], ['approved_at', '2026-01-15']]},
  'rule.valid': {set: [['valid', 'timeless']]},
  'default.except': {set: [['except', 'blocked ?x']]},
  'default.overrides': {set: [['overrides', '$d_other']]},
  'aggregate.sum': {set: [['sum', '?y as ?c']], remove: ['count'], over: 'val ?x ?y'},
  'aggregate.min': {set: [['min', '?y as ?c']], remove: ['count'], over: 'val ?x ?y'},
  'aggregate.max': {set: [['max', '?y as ?c']], remove: ['count'], over: 'val ?x ?y'},
  'aggregate.collect': {set: [['collect', '?y as ?c']], remove: ['count']},
  'aggregate.group': {set: [['group', '?x']]},
  'constraint.objective': {set: [['objective', '?x'], ['direction', 'min'], ['task', 'optimize']], remove: ['claim', 'task']},
  'constraint.direction': {set: [['objective', '?x'], ['direction', 'min'], ['task', 'optimize']], remove: ['claim', 'task']},
  'constraint.select': {set: [['select', '?x']]},
  'constraint.unit': {set: [['unit', '"kg"']]},
  'action.removes': {set: [['removes', 'p ?x']]},
  'action.next': {set: [['next', 'x0 ?x0 + 1']]},
  'action.guard': {set: [['next', 'x0 ?x0 + 1'], ['guard', '?x0 below 10']]},
  'method.when': {set: [['when', 'p ?x']]},
  'method.prefer': {set: [['step', 'choose\n    ~act ?x\n    ~act2 ?x\n  end'], ['prefer', '~act over ~act2']], remove: ['step']},
  'method.on_failure': {set: [['on_failure', 'abort']]},
  'method.triggered_by': {set: [['triggered_by', 'p ?x']]},
  'procedure.report': {set: [['report', 'q ?x']]},
  'norm.oblige': {set: [['oblige', '~act ?x'], ['when', 'p ?x']], remove: ['forbid']},
  'norm.permit': {set: [['permit', '~act ?x'], ['overrides', '$n_other']], remove: ['forbid']},
  'norm.when': {set: [['when', 'p ?x']]},
  'norm.before': {set: [['before', '~act2']]},
  'norm.after': {set: [['after', '~act2']]},
  'norm.within': {set: [['oblige', '~act ?x'], ['when', 'p ?x'], ['within', '3']], remove: ['forbid']},
  'norm.always': {set: [['always', '']]},
  'norm.sometime': {set: [['oblige', '~act ?x'], ['when', 'p ?x'], ['sometime', '']], remove: ['forbid']},
  'norm.at_most_once': {set: [['at_most_once', '']]},
  'norm.standing': {set: [['oblige', '~act ?x'], ['when', 'p ?x'], ['standing', '']], remove: ['forbid']},
  'norm.cost': {set: [['severity', 'soft'], ['cost', '2']]},
  'norm.overrides': {set: [['permit', '~act ?x'], ['overrides', '$n_other']], remove: ['forbid']},
  'amendment.members': {set: [['members', '$r_new']], remove: ['removes'], ctx: '@r_new rule\n  when p ?x\n  then q ?x\n  version 2\n  supersedes $r_old\n  approval proposed\n'},
  'amendment.removes': {set: [['removes', '$r_old']]},
  'argument.against': {set: [['against', '$r_old']], remove: ['for']},
  'argument.cost_delta': {set: [['cost_delta', '-1']]},
  'hypothesis.assume': {set: [['assume', 'p d']], remove: ['holds']},
  'hypothesis.waive': {set: [['waive', '$n_other']], remove: ['holds']},
  'policy.procedures': {set: [['procedures', '$proc']]},
  'policy.scope': {set: [['scope', '"night shift"']]},
  'stated.role': {set: [['role', 'object "b"']]},
  'stated.valid': {set: [['valid', '"2020"']]},
  'stated.speaker': {set: [['speaker', '"Ann"']]},
  'query.mode': {set: [['mode', 'select']]},
  'query.scope': {set: [['mode', 'every'], ['scope', 'p ?x']], remove: ['select']},
  'query.at': {set: [['at', '2021-01-01']]},
  'query.during': {set: [['during', '2020-01-01 2022-01-01']]},
  'query.overlaps': {set: [['overlaps', '2020-01-01 2022-01-01']]},
  'query.asof': {set: [['asof', '2021-01-01']]},
  'query.trace': {set: [['mode', 'conform'], ['trace', '$tr']], remove: ['where', 'select'], ctx: '@tr trace\n  step ~act a\n'},
  'query.via': {set: [['mode', 'why_not'], ['where', 'q b'], ['via', '~act b']], remove: ['where', 'select']},
  'query.compare': {set: [['compare', '?n above 1']]},
  'query.order': {set: [['order', 'random']]},
  'query.rank': {set: [['rank', 'highest ?n']]},
  'query.filter': {set: [['filter', '?n > 1']]},
  'query.measure': {set: [['where', 'start_of ?t p ?x'], ['select', '?t'], ['measure', 'start']], remove: ['where', 'select']},
  'query.quantifier': {set: [['mode', 'every'], ['scope', 'p ?x'], ['quantifier', 'most']], remove: ['select']},
  'query.except': {set: [['except', '?x a']]},
  'query.limit': {set: [['limit', '1']]},
  'query.policy': {set: [['policy', '$pol']], qctx: '@pol policy\n  maxNodes 100\n'},
  'query.observe': {set: [['mode', 'plan'], ['observe', 'demo ?x0 at_least 3'], ['horizon', '3']], remove: ['where', 'select']},
  'query.horizon': {set: [['mode', 'plan'], ['observe', 'demo ?x0 at_least 3'], ['horizon', '3']], remove: ['where', 'select']},
  'test.kind': {set: [['kind', 'example']]},
  'test.timeout': {set: [['timeout', '100']]},
  'code.produced_by': {set: [['produced_by', 'user']]}
};
for (const link of ['because', 'so', 'if', 'unless', 'although', 'so_that', 'before', 'after', 'when', 'while']) PATCH['query.' + link] = {set: [[link, '$s1']], qctx: '@s1 fact\n  holds p c\n  status supposed\n'};
// candidates (Q-LANG-10): a supposed fact the query tries (mode abduce or effect over a ground claim)
PATCH['query.candidate'] = {set: [['mode', 'abduce'], ['where', 'q b'], ['candidate', '$s1']], remove: ['select', 'where'], qctx: '@s1 fact\n  holds p b\n  status supposed\n'};
for (const k of Object.keys(GOV)) for (const t of ['default', 'integrity', 'action', 'method', 'norm', 'code']) PATCH[`${t}.${k}`] ??= PATCH[`rule.${k}`];
/** Enum values that need more than the value itself (a query mode with its forms). */
const ENUM_PATCH = {
  'query.mode.every': {set: [['mode', 'every'], ['scope', 'p ?x']], remove: ['select']},
  'query.mode.explain': {set: [['mode', 'explain'], ['where', 'val a 3']], remove: ['select', 'where']},
  'query.mode.exists': {set: [['mode', 'exists'], ['where', 'val a 3']], remove: ['select', 'where']},
  'query.mode.why_not': {set: [['mode', 'why_not'], ['where', 'q b']], remove: ['select', 'where']},
  'query.mode.abduce': {set: [['mode', 'abduce'], ['where', 'q b']], remove: ['select', 'where']},
  'query.mode.effect': {set: [['mode', 'effect'], ['where', 'q b'], ['candidate', '$s1']], remove: ['select', 'where'], qctx: '@s1 fact\n  holds p b\n  status supposed\n'},
  'query.mode.plan': {set: [['mode', 'plan'], ['where', 'q a']], remove: ['select', 'where']},
  'query.mode.conform': {set: [['mode', 'conform'], ['trace', '$tr']], remove: ['select', 'where'], ctx: '@tr trace\n  step ~act a\n'},
  'query.mode.procedure': {set: [['mode', 'procedure'], ['where', 'q a']], remove: ['select', 'where']},
  'query.quantifier.at_least': {set: [['mode', 'every'], ['scope', 'p ?x'], ['quantifier', 'at_least 2']], remove: ['select']},
  'query.measure.start': {set: [['where', 'start_of ?t p ?x'], ['select', '?t'], ['measure', 'start']], remove: ['where', 'select']},
  'query.measure.end': {set: [['where', 'end_of ?t p ?x'], ['select', '?t'], ['measure', 'end']], remove: ['where', 'select']},
  'query.measure.duration': {set: [['where', 'start_of ?t p ?x'], ['select', '?t'], ['measure', 'duration']], remove: ['where', 'select']},
  'constraint.task.optimize': {set: [['objective', '?x'], ['direction', 'min'], ['task', 'optimize']], remove: ['claim', 'task']},
  'constraint.task.possible': {set: [['task', 'possible']]},
  'fact.status.reported': {set: [['status', 'reported'], ['speaker', '"Ann"']]},
  'test.kind.sealed': {set: [['kind', 'sealed']], expect: 'sealed_test_in_knowledge'},
  'query.quantifier.at_least': {set: [['mode', 'every'], ['scope', 'p ?x'], ['quantifier', 'at_least 2']], remove: ['select']},
  'norm.severity.soft': {set: [['severity', 'soft'], ['cost', '1']]},
  'norm.binding.advisory': {set: [['binding', 'advisory'], ['severity', 'hard']]}
};
for (const t of ['rule', 'default', 'integrity', 'action', 'method', 'norm', 'code']) {
  ENUM_PATCH[`${t}.approval.approved`] = {set: [['approval', 'approved'], ['approved_by', '"owner"'], ['approved_at', '2026-01-15']]};
  for (const v of ['contested', 'rejected', 'superseded', 'retired']) ENUM_PATCH[`${t}.approval.${v}`] = {set: [['approval', v], ['approved_by', '"owner"'], ['approved_at', '2026-01-15']]};
}
/** A value of the wrong form per kind, and the code the validator must report. */
const BAD = {
  bool: ['maybe', 'bad_value'], quantifier: ['some', 'bad_enum'], int: ['many', 'bad_value'], posint: ['0', 'bad_value'], enum: ['no_such_value', 'bad_enum'], time: ['soon', 'bad_time'], vars: ['x', 'bad_vars'],
  ref: ['r_old', 'bad_ref'], reflist: ['r_old', 'bad_ref'], sym: ['Bad Symbol', 'bad_value'], date: ['yesterday', 'bad_time'], instant: ['yesterday', 'bad_time'], interval: ['2020-01-01', 'bad_time'],
  langcode: ['english', 'bad_language'], argtypes: ['subject:thing', 'bad_args'], roletype: ['actor entity', 'bad_role'], rolelist: ['actor', 'bad_frame'], restrict: ['actor entity', 'bad_restrict'],
  cond: ['p(?x)', 'bad_atom'], natom: ['p(?x)', 'bad_atom'], atom: ['p(?x)', 'bad_atom'], groundatom: ['p ?x', 'bad_atom'], groundnatom: ['p ?x', 'bad_atom'], aggspec: ['?y', 'bad_aggspec'],
  vardecl: ['?x real', 'bad_var_decl'], cmp: ['?x > 1', 'bad_expression'], expr: ['?x +', 'bad_expression'], ident: ['1f', 'bad_value'], flag: ['yes', 'bad_value'], stepref: ['act', 'bad_ref'],
  normpat: ['p(?x)', 'bad_norm_pattern'], prefer: ['~act', 'bad_prefer'], onfail: ['retry', 'bad_value'], viastep: ['act a', 'bad_step'], groundstep: ['act a', 'bad_step'], step: ['p(?x)', 'bad_step'],
  replytext: ['Hello', 'bad_value'], phrase: ['is p', 'bad_value'], langtext: ['en', 'bad_value'], text: ['', 'bad_value'], role: ['actor "a"', 'bad_role'], numnext: ['x', 'bad_next'], numguard: ['x', 'bad_guard'], numobserve: ['x', 'bad_observe']
};

const lines = fields => fields.map(([k, v]) => `  ${k}${v === '' ? '' : ' ' + v}`).join('\n');
function knowledgeCase(type, fields, patch = {}) {
  const sk = SKELETON[type];
  let fs = fields;
  const role = sk.role ?? 'knowledge';
  const wire = `@w ${type}\n${lines(fs)}\n`;
  const kctx = CTX + (patch.ctx ?? '');
  if (role === 'query') return {files: [{name: 'knowledge', text: kctx, role: 'knowledge'}, {name: 'query', text: (patch.qctx ?? '') + wire, role: 'query'}]};
  return {files: [{name: 'knowledge', text: kctx + wire, role: 'knowledge'}]};
}
function apply(skeleton, patch) {
  let fields = skeleton.filter(([k]) => !(patch.remove ?? []).includes(k));
  const setKeys = new Set((patch.set ?? []).map(([k]) => k));
  // a field set by the patch replaces the skeleton's value of the same key unless the field repeats
  fields = fields.filter(([k]) => !setKeys.has(k) || (patch.keep ?? []).includes(k));
  if (patch.over) fields = fields.map(([k, v]) => (k === 'over' ? ['over', patch.over] : [k, v]));
  return [...fields, ...(patch.set ?? [])];
}

/** Every generated knowledge L1 case: {id, surface, capability, expect: 'valid' | code, files}. */
export function knowledgeCases() {
  const cases = [], missing = [];
  for (const [type, g] of Object.entries(GRAMMAR)) {
    const sk = SKELETON[type];
    if (!sk) { missing.push('k.wire.' + type); continue; }
    cases.push({id: `k:${type}:skeleton`, capability: 'k.wire.' + type, expect: 'valid', ...knowledgeCase(type, sk.fields)});
    cases.push({id: `k:${type}:unknown_field`, capability: 'k.wire.' + type, expect: 'unknown_field', ...knowledgeCase(type, [...sk.fields, ['no_such_keyword', 'x']])});
    for (const [field, spec] of Object.entries(g.fields)) {
      const cap = `k.field.${type}.${field}`;
      const key = `${type}.${field}`;
      let patch = Object.hasOwn(PATCH, key) ? PATCH[key] : null;
      // a newer version names an older wire of the same type, marked superseded
      if (field === 'supersedes') patch = {set: [['supersedes', '$w_old'], ['version', '2']], ctx: `@w_old ${type}\n${lines(sk.fields)}\n  approval superseded\n  approved_by "owner"\n  approved_at 2026-01-01\n`};
      if (patch === null && Object.hasOwn(PATCH, key)) { missing.push(cap); }
      else {
        if (!patch) {
          const inSkeleton = sk.fields.find(([k]) => k === field);
          if (inSkeleton) patch = {set: [inSkeleton]};
          else if (spec.values) patch = {set: [[field, spec.values[0]]]};
          else if (Object.hasOwn(BY_KIND, spec.kind)) patch = {set: [[field, BY_KIND[spec.kind]]]};
        }
        if (!patch) missing.push(cap);
        else cases.push({id: `k:${key}:valid`, capability: cap, expect: 'valid', ...knowledgeCase(type, apply(sk.fields, patch), patch)});
        if (patch) {
          const value = patch.set.find(([k]) => k === field)?.[1];
          if (spec.card === 'one' && value !== undefined) cases.push({id: `k:${key}:repeated`, capability: cap, expect: 'repeated_field', ...knowledgeCase(type, [...apply(sk.fields, patch), [field, value]], patch)});
          if (BAD[spec.kind]) {
            const [bad, code] = BAD[spec.kind];
            cases.push({id: `k:${key}:bad_form`, capability: cap, expect: code, ...knowledgeCase(type, apply(sk.fields, {...patch, set: patch.set.map(([k, v]) => (k === field ? [k, bad] : [k, v]))}), patch)});
          }
        }
      }
      if (spec.required) cases.push({id: `k:${key}:missing`, capability: cap, expect: 'missing_field', ...knowledgeCase(type, sk.fields.filter(([k]) => k !== field))});
      if (spec.values) for (const v of spec.values) {
        const ek = `${type}.${field}.${v}`;
        const ep = Object.hasOwn(ENUM_PATCH, ek) ? ENUM_PATCH[ek] : {set: [...(patch?.set ?? []).filter(([k]) => k !== field), [field, v]], remove: patch?.remove, ctx: patch?.ctx, qctx: patch?.qctx};
        if (ep === null) { missing.push('k.enum.' + ek); continue; }
        cases.push({id: `k:${ek}:valid`, capability: 'k.enum.' + ek, expect: ep.expect ?? 'valid', ...knowledgeCase(type, apply(sk.fields, ep), ep)});
      }
    }
  }
  // condition-leaf words (sop/enums.mjs): every compute, comparator and ordering word in a rule, and the same leaf malformed
  const rule = body => knowledgeCase('rule', [['when', 'val ?x ?n'], ...body.map(b => ['when', b]), ['then', 'q ?x']]);
  for (const w of COMPUTE_WORDS) {
    cases.push({id: `k:leaf.compute.${w}:valid`, capability: 'k.leaf.compute.' + w, expect: 'valid', ...rule([`compute ?m ?n ${w} 2`, 'compare ?m at_least 1'])});
    cases.push({id: `k:leaf.compute.${w}:bad_form`, capability: 'k.leaf.compute.' + w, expect: 'bad_compute', ...rule([`compute ?m ?n ${w}`])});
  }
  for (const w of Object.keys(COMPARATOR_WORDS)) {
    cases.push({id: `k:leaf.compare.${w}:valid`, capability: 'k.leaf.compare.' + w, expect: 'valid', ...rule([`compare ?n ${w} 2`])});
    cases.push({id: `k:leaf.compare.${w}:bad_form`, capability: 'k.leaf.compare.' + w, expect: 'bad_compare', ...rule([`compare ?n ${w}`])});
  }
  for (const w of ORDER_WORDS) {
    const timed = knowledgeCase('rule', [['when', 'start_of ?t1 p ?x'], ['when', 'start_of ?t2 val ?x ?n'], ['when', `order ?t1 ${w} ?t2`], ['then', 'r2 ?x ?x']]);
    cases.push({id: `k:leaf.order.${w}:valid`, capability: 'k.leaf.order.' + w, expect: 'valid', ...timed});
    cases.push({id: `k:leaf.order.${w}:bad_form`, capability: 'k.leaf.order.' + w, expect: 'bad_order', ...knowledgeCase('rule', [['when', 'start_of ?t1 p ?x'], ['when', `order ?t1 ${w}`], ['then', 'q ?x']])});
  }
  return {cases, missing};
}

// ------------------------------------------------------------------------------------------------ model surface

const MODEL_SKELETON = {
  stated: [['relation', '"work at"'], ['role', 'subject "Ann"'], ['role', 'object "Acme"'], ['polarity', 'affirmed'], ['certainty', 'asserted']],
  assumed: [['relation', '"work at"'], ['role', 'subject "Ann"'], ['polarity', 'affirmed'], ['basis', 'world']],
  unclear: [['kind', 'gibberish']],
  unparsed: [['span', '"flibber"']],
  pragmatic: [['kind', 'greeting'], ['basis', 'llm']],
  instruction: [['do', 'list']],
  query: [['where', 'match\n    relation "work at"\n    role subject ?x\n    polarity affirmed\n  end'], ['select', '?x']],
  constraint: [['var', '?x int 0 5'], ['require', '?x at_least 1'], ['select', '?x'], ['task', 'possible']]
};
const MATCH_N = 'match\n    relation "earn"\n    role subject ?x\n    role object ?n\n    polarity affirmed\n  end';
const MATCH_T = 'match\n    relation "work at"\n    role subject "Ann"\n    role time ?t\n    polarity affirmed\n  end';
const MODEL_PATCH = {
  'stated.valid': {set: [['valid', 'on "2020"']]}, 'stated.speaker': {set: [['speaker', '"Bob"']]},
  'assumed.valid': {set: [['valid', 'on "2020"']]},
  'unclear.reading': {set: [['kind', 'ambiguous'], ['reading', '"the first reading"'], ['reading', '"the second reading"']]},
  'unclear.language': {set: [['language', 'en']]},
  'unparsed.near': {set: [['near', '$ctx_q']], ctx: true}, 'unparsed.hint': {set: [['hint', 'other']]},
  'pragmatic.score': {set: [['score', '0.8']]}, 'pragmatic.span': {set: [['span', '"hello"']]}, 'pragmatic.near': {set: [['near', '$ctx_q']], ctx: true}, 'pragmatic.source': {set: [['source', 'llm_direct']]},
  'instruction.kind': {set: [['do', 'set'], ['kind', 'short']]}, 'instruction.text': {set: [['do', 'set'], ['kind', 'prefix'], ['text', '"Note:"']]},
  'instruction.span': {set: [['span', '"list them"']]}, 'instruction.source': {set: [['source', 'llm_direct']]},
  'query.mode': {set: [['mode', 'select']]},
  'query.scope': {set: [['mode', 'every'], ['scope', MATCH_N.replace('?x', '?x').replace('earn', 'be certified').replace('    role object ?n\n', '')]], remove: ['select']},
  'query.measure': {set: [['where', MATCH_T], ['select', '?t'], ['measure', 'start']], remove: ['where', 'select']},
  'query.span': {set: [['span', '?x']], expect: 'host plumbing'},
  'query.at': {set: [['at', '"2020"']]}, 'query.during': {set: [['during', '"2020"']]}, 'query.overlaps': {set: [['overlaps', '"2020"']]}, 'query.asof': {set: [['asof', '"2020"']]},
  'query.limit': {set: [['limit', '2']]},
  'query.rank': {set: [['where', MATCH_N], ['select', '?x ?n'], ['rank', 'highest ?n']], remove: ['where', 'select']},
  'query.quantifier': {set: [['mode', 'every'], ['scope', 'match\n    relation "be certified"\n    role subject ?x\n    polarity affirmed\n  end'], ['quantifier', 'most']], remove: ['select']},
  'query.order': {set: [['order', 'random']]},
  'query.fragment': {set: [['fragment', 'follow_up']]},
  'query.filter': {set: [['filter', '?x == "Ann"']], expect: 'operator_not_words'},
  'query.compare': {set: [['where', MATCH_N], ['select', '?x ?n'], ['compare', '?n above 10']], remove: ['where', 'select']},
  'query.except': {set: [['except', '?x "Ann"']]},
  'query.candidate': {set: [['mode', 'abduce'], ['where', 'match\n    relation "work at"\n    role subject "Ann"\n    polarity affirmed\n  end'], ['candidate', '$ctx_c']], remove: ['select', 'where'], ctx: 'candidate'},
  'constraint.claim': {set: [['claim', '?x equal 2'], ['task', 'prove']], remove: ['task']},
  'constraint.objective': {set: [['objective', '?x'], ['direction', 'max'], ['task', 'optimize']], remove: ['task']},
  'constraint.direction': {set: [['objective', '?x'], ['direction', 'max'], ['task', 'optimize']], remove: ['task']},
  'constraint.unit': {set: [['unit', '"kg"']]}
};
for (const link of ['because', 'so', 'if', 'unless', 'although', 'so_that', 'before', 'after', 'when', 'while']) for (const t of ['stated', 'assumed', 'query']) MODEL_PATCH[`${t}.${link}`] = {set: [[link, '$ctx_s']], ctx: 'supposed'};
const MODEL_ENUM_PATCH = {
  'query.mode.every': MODEL_PATCH['query.scope'],
  'query.mode.explain': {set: [['mode', 'explain'], ['where', 'match\n    relation "work at"\n    role subject "Ann"\n    role object "Acme"\n    polarity affirmed\n  end']], remove: ['select', 'where']},
  'query.mode.exists': {set: [['mode', 'exists']]},
  'query.mode.effect': {set: [['mode', 'effect'], ['where', 'match\n    relation "work at"\n    role subject "Ann"\n    polarity affirmed\n  end'], ['candidate', '$ctx_c']], remove: ['select', 'where'], ctx: 'candidate'},
  'query.measure.start': MODEL_PATCH['query.measure'], 'query.measure.end': {...MODEL_PATCH['query.measure'], set: [['where', MATCH_T], ['select', '?t'], ['measure', 'end']]},
  'query.measure.duration': {...MODEL_PATCH['query.measure'], set: [['where', MATCH_T], ['select', '?t'], ['measure', 'duration']]},
  'query.fragment.follow_up': MODEL_PATCH['query.fragment'],
  'unclear.kind.ambiguous': MODEL_PATCH['unclear.reading'],
  'instruction.do.set': {set: [['do', 'set'], ['kind', 'short']]},
  'instruction.do.cancel': {set: [['do', 'cancel']]},
  'instruction.kind.prefix': {set: [['do', 'set'], ['kind', 'prefix'], ['text', '"Note:"']]},
  'instruction.kind.suffix': {set: [['do', 'set'], ['kind', 'suffix'], ['text', '"Thanks."']]},
  'instruction.kind.short': {set: [['do', 'set'], ['kind', 'short']]},
  'instruction.kind.detailed': {set: [['do', 'set'], ['kind', 'detailed']]},
  'constraint.task.prove': MODEL_PATCH['constraint.claim'],
  'constraint.task.optimize': MODEL_PATCH['constraint.objective']
};
const MODEL_CTX = {
  supposed: '\n@ctx_s stated\n  relation "rain"\n  role subject "Paris"\n  polarity affirmed\n  certainty supposed\n',
  true: '\n@ctx_q query\n  where match\n    relation "live in"\n    role subject ?x\n    polarity affirmed\n  end\n  select ?x\n',
  candidate: '\n@ctx_c stated\n  relation "hire"\n  role subject "Acme"\n  role object "Ann"\n  polarity affirmed\n  certainty supposed\n'
};
function modelText(type, fields, patch = {}) {
  const ctx = patch.ctx ? MODEL_CTX[patch.ctx] : '';
  return `@w ${type}\n${fields.map(([k, v]) => `  ${k} ${v}`).join('\n')}\n` + ctx;
}
const MODEL_BAD = {mode: 'no_such_mode', certainty: 'sure', polarity: 'maybe', basis: 'guess', kind: 'no_such_kind', hint: 'nowhere', task: 'guess', direction: 'up', measure: 'when', fragment: 'other', do: 'shout', language: 'xx'};

export function modelCases() {
  const cases = [], missing = [];
  for (const type of MODEL_TYPES) {
    const sk = MODEL_SKELETON[type], s = SPEC[type];
    if (!sk) { missing.push('m.wire.' + type); continue; }
    cases.push({id: `m:${type}:skeleton`, capability: 'm.wire.' + type, expect: 'valid', text: modelText(type, sk)});
    cases.push({id: `m:${type}:unknown_field`, capability: 'm.wire.' + type, expect: 'Unsupported field', text: modelText(type, [...sk, ['no_such_keyword', 'x']])});
    for (const field of [...(s.one ?? []), ...(s.many ?? [])]) {
      const cap = `m.field.${type}.${field}`, key = `${type}.${field}`;
      let patch = Object.hasOwn(MODEL_PATCH, key) ? MODEL_PATCH[key] : undefined;
      if (patch === undefined) { const inSk = sk.find(([k]) => k === field); if (inSk) patch = {set: [inSk]}; else if (enumValues(type, field)) patch = {set: [[field, enumValues(type, field)[0]]]}; }
      if (!patch) { missing.push(cap); continue; }
      const fields = apply(sk, patch);
      cases.push({id: `m:${key}:${patch.expect ? 'refused' : 'valid'}`, capability: cap, expect: patch.expect ?? 'valid', text: modelText(type, fields, patch)});
      if (patch.expect) continue;
      const value = patch.set.find(([k]) => k === field)?.[1];
      if ((s.one ?? []).includes(field) && value !== undefined) cases.push({id: `m:${key}:repeated`, capability: cap, expect: 'Duplicate', text: modelText(type, [...fields, [field, value]], patch)});
      if ((s.required ?? []).includes(field)) cases.push({id: `m:${key}:missing`, capability: cap, expect: 'needs', text: modelText(type, sk.filter(([k]) => k !== field))});
      if (enumValues(type, field) && MODEL_BAD[field]) cases.push({id: `m:${key}:bad_value`, capability: cap, expect: 'must be', text: modelText(type, fields.map(([k, v]) => (k === field ? [k, MODEL_BAD[field]] : [k, v])), patch)});
      for (const v of enumValues(type, field) ?? []) {
        const ek = `${type}.${field}.${v}`;
        const ep = MODEL_ENUM_PATCH[ek] ?? {...patch, set: [...patch.set.filter(([k]) => k !== field), [field, v]]};
        cases.push({id: `m:${ek}:valid`, capability: 'm.enum.' + ek, expect: 'valid', text: modelText(type, apply(sk, ep), ep)});
      }
    }
  }
  return {cases, missing};
}

// ------------------------------------------------------------------------------------------------ expression language (jsEval)

/**
 * Per operation of sop/expression.mjs a valid sample (expression, value) and an invalid one (expression, error text). An operation of the
 * exported tables without a sample is reported missing. `e.arrow` is the pure arrow function of the bounded operations (proposal P-6).
 */
const EXPRESSION_SAMPLES = {
  'fn.String': [['String(12)', '12'], ['String([1])', 'Primitive conversion expected']],
  'fn.Number': [['Number("2.5")', 2.5], ['Number({})', 'Primitive conversion expected']],
  'fn.only': [['only([7])', 7], ['only([1, 2])', 'requires exactly one result']],
  'fn.range': [['range(2, 5)', [2, 3, 4]], ['range(0.5)', 'takes integers']],
  'fn.sum': [['sum([1, 2, 3.5])', 6.5], ['sum(["a"])', 'array of numbers']],
  'fn.count': [['count(range(10), x => x % 4 == 0)', 3], ['count(3)', 'count(array)']],
  'fn.min': [['min([4, 2, 9])', 2], ['min([])', 'empty array']],
  'fn.max': [['max([4, 2, 9])', 9], ['max(1, 2)', 'takes one array']],
  'math.abs': [['Math.abs(-3)', 3], ['Math.abs("x")', 'Math operation not allowed']],
  'math.min': [['Math.min(4, 2)', 2], ['Math.min()', 'Math operation not allowed']],
  'math.max': [['Math.max(4, 2)', 4], ['Math.max([1])', 'Math operation not allowed']],
  'math.floor': [['Math.floor(2.7)', 2], ['Math.floor(true)', 'Math operation not allowed']],
  'math.ceil': [['Math.ceil(2.1)', 3], ['Math.ceil()', 'Math operation not allowed']],
  'math.round': [['Math.round(2.5)', 3], ['Math.round("2")', 'Math operation not allowed']],
  'math.pow': [['Math.pow(2, 10)', 1024], ['Math.pow(10, 400)', 'Nonfinite result']],
  'string.trim': [['" a ".trim()', 'a'], ['" a ".trim(1)', 'Method takes no arguments']],
  'string.toLowerCase': [['"AB".toLowerCase()', 'ab'], ['(1).toLowerCase()', 'String method requires string']],
  'string.toUpperCase': [['"ab".toUpperCase()', 'AB'], ['"ab".toUpperCase("x")', 'Method takes no arguments']],
  'string.normalize': [['"é".normalize("NFC")', 'é'], ['"é".normalize("X")', 'Invalid normalization']],
  'string.slice': [['"abcd".slice(1, 3)', 'bc'], ['"abcd".slice("1")', 'Integer indices expected']],
  'string.substring': [['"abcd".substring(2)', 'cd'], ['"abcd".substring(0.5)', 'Integer indices expected']],
  'string.includes': [['"abcd".includes("bc")', true], ['"abcd".includes(1)', 'One string expected']],
  'string.startsWith': [['"abcd".startsWith("ab")', true], ['"abcd".startsWith()', 'One string expected']],
  'string.endsWith': [['"abcd".endsWith("cd")', true], ['"abcd".endsWith(1)', 'One string expected']],
  'string.replaceAll': [['"a-b-c".replaceAll("-", "+")', 'a+b+c'], ['"a".replaceAll("a")', 'Literal replacement only']],
  'string.split': [['"a,b".split(",")', ['a', 'b']], ['"a,b".split()', 'Literal delimiter expected']],
  'array.slice': [['[1, 2, 3].slice(1)', [2, 3]], ['[1, 2, 3].slice("1")', 'Integer indices expected']],
  'array.join': [['[1, 2].join("-")', '1-2'], ['[[1]].join("-")', 'join requires primitive array']],
  'array.map': [['[1, 2].map((x, i) => x * 10 + i)', [10, 21]], ['[1].map((a, b, c) => a)', 'passes at most 2 arguments']],
  'array.filter': [['[1, 2, 3].filter(x => x > 1)', [2, 3]], ['[1].filter(1)', 'filter takes one function']],
  'array.reduce': [['[1, 2, 3].reduce((a, x) => a + x, 0)', 6], ['[].reduce((a, x) => a + x)', 'needs an initial value']],
  'array.sort': [['[3, 1, 2].sort((a, b) => a - b)', [1, 2, 3]], ['[3, 1].sort()', 'sort takes a comparator']],
  'array.includes': [['[1, 2].includes(2)', true], ['[1].includes([1])', 'includes takes one number']],
  arrow: [['[1, 2].map(x => x * x)', [1, 4]], ['(x => x)(1)', 'Unsupported call']],
};

export function expressionCases() {
  const cases = [], missing = [];
  const ops = [...EXPRESSION_FUNCTIONS.map(f => 'fn.' + f), ...EXPRESSION_MATH.map(f => 'math.' + f), ...EXPRESSION_STRING_METHODS.map(f => 'string.' + f), ...EXPRESSION_ARRAY_METHODS.map(f => 'array.' + f), 'arrow'];
  for (const op of ops) {
    const sample = EXPRESSION_SAMPLES[op];
    if (!sample) { missing.push('e.' + op); continue; }
    const [[good, value], [bad, error]] = sample;
    cases.push({id: `e:${op}:valid`, capability: 'e.' + op, expect: 'valid', expr: good, value, text: `@w jsEval\n  expr ${good}\n`});
    cases.push({id: `e:${op}:refused`, capability: 'e.' + op, expect: error, expr: bad, text: `@w jsEval\n  expr ${bad}\n`});
  }
  return {cases, missing};
}

// ------------------------------------------------------------------------------------------------ the jsEval route's admission

const JS_MESSAGE = 'Pens cost 3 dollars and notebooks 5 dollars. Ann buys 4 pens and 2 notebooks. Who spends more, Ann or Ben with 30 dollars?';
/** Per admission code of lib/formalize/js-program.mjs a program that must be refused with it, and a valid program. */
const JS_ROUTE_SAMPLES = {
  valid: '@ann jsEval\n  expr $v3 * $v1 + $v4 * $v2\n@answer jsEval\n  expr $ann > $v5 ? "Ann" : "Ben"',
  js_no_wire: 'The answer is Ann.',
  js_route_type: '@a value\n  data 3',
  js_missing_expr: '@a jsEval',
  js_extra_field: '@a jsEval\n  expr $v1\n  data 3',
  js_redefines_registry: '@v1 jsEval\n  expr 4',
  js_reserved_name: '@sum jsEval\n  expr $v1',
  js_duplicate_name: '@a jsEval\n  expr $v1\n@a jsEval\n  expr $v2',
  js_parse_error: '@a jsEval\n  expr [$v1].map(x => { return x })',
  js_unknown_reference: '@a jsEval\n  expr $b + $v1\n@b jsEval\n  expr $v2',
  js_unknown_registry_index: '@a jsEval\n  expr $v9',
  js_variable: '@a jsEval\n  expr ?x + $v1',
  js_text_not_in_message: '@a jsEval\n  expr $v1 > 2 ? "Carl" : "Ann"',
  js_answer_not_from_data: '@answer jsEval\n  expr 22',
  js_runtime_error: '@a jsEval\n  expr $v1 + process.env',
  js_answer_shape: '@a jsEval\n  expr ({x: $v1})',
};

export function jsRouteCases() {
  const cases = [], missing = [];
  const codes = [...new Set([...fs.readFileSync(path.join(ROOT, 'lib/formalize/js-program.mjs'), 'utf8').matchAll(/\bbad\('(js_[a-z_]+)'/g)].map(m => m[1]).concat(['js_unknown_registry_index']))];
  cases.push({id: 'j:wire.jsEval:valid', capability: 'j.wire.jsEval', expect: 'valid', jsRoute: JS_ROUTE_SAMPLES.valid, text: JS_ROUTE_SAMPLES.valid});
  for (const code of codes) {
    if (!JS_ROUTE_SAMPLES[code]) { missing.push('j.check.' + code); continue; }
    cases.push({id: `j:check.${code}`, capability: 'j.check.' + code, expect: code, jsRoute: JS_ROUTE_SAMPLES[code], text: JS_ROUTE_SAMPLES[code]});
  }
  return {cases, missing};
}

/** Hand-written cases for validator rules and combinations (eval/capabilities/l1-cases.json). */
export function extraCases() {
  if (!fs.existsSync(EXTRA)) return [];
  return JSON.parse(fs.readFileSync(EXTRA, 'utf8')).cases.map(c => c.surface === 'model' ? {...c, text: c.text} : {...c, files: c.files ?? [{name: 'knowledge', text: c.knowledge ?? '', role: 'knowledge'}, ...(c.query ? [{name: 'query', text: c.query, role: 'query'}] : [])]});
}

/** Run one case: {pass, got}. A knowledge case passes when `valid` has no error, or when the expected code is reported. */
export function runCase(c) {
  if (c.fol !== undefined) return {pass: false, got: 'a converter case executes its circuits: run it with runFolCases (./l1-fol.mjs)'};
  if (c.expr !== undefined) {
    let r;
    try { r = {ok: true, value: runExpression(c.expr).value}; } catch (e) { r = {ok: false, message: e.message}; }
    if (c.expect === 'valid') return {pass: r.ok && JSON.stringify(r.value) === JSON.stringify(c.value), got: r.ok ? JSON.stringify(r.value) : r.message};
    return {pass: !r.ok && r.message.includes(c.expect), got: r.ok ? 'valid' : r.message};
  }
  if (c.jsRoute !== undefined) {
    const a = admitJsProgram(readWires(c.jsRoute), registryOf(JS_MESSAGE), JS_MESSAGE);
    const got = a.ok ? 'valid' : a.violations.map(v => v.code).join(',');
    return {pass: c.expect === 'valid' ? a.ok : a.violations.some(v => v.code === c.expect), got};
  }
  if (c.files) {
    const r = validateKnowledge(c.files);
    if (c.expect === 'valid') return {pass: r.errors.length === 0, got: r.errors.join(',') || 'valid'};
    return {pass: [...r.errors, ...r.warnings].includes(c.expect), got: [...r.errors, ...r.warnings].join(',') || 'valid'};
  }
  const r = validateModel(c.text);
  if (c.expect === 'valid') return {pass: r.ok, got: r.ok ? 'valid' : r.message};
  return {pass: !r.ok && (r.code === c.expect || r.message.includes(c.expect)), got: r.ok ? 'valid' : r.message};
}

/** Every L1 case; the converter cases (`fol` set, ./l1-fol.mjs) execute and run asynchronously (`runFolCases`), the rest through `runCase`. */
export function allCases() {
  const k = knowledgeCases(), m = modelCases(), e = expressionCases(), j = jsRouteCases(), f = folCases();
  return {cases: [...k.cases, ...m.cases, ...e.cases, ...j.cases, ...extraCases(), ...f.cases], missing: [...k.missing, ...m.missing, ...e.missing, ...j.missing, ...f.missing]};
}
