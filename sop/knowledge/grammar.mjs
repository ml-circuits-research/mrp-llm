/**
 * The knowledge-surface grammar of SOP (DS004 "Knowledge wires"): one table of wire types and their fields, with the
 * closed vocabularies the parser and the validator read. This is the single source: `sop/knowledge/` is imported by the
 * reasoning strategies (`reasoning/strategies/`), the smoke harness (`eval/smoke-reasoning/`) and the wire help tests, and
 * the grammar tables of the documentation are generated from it (`node eval/smoke-reasoning/validator.mjs --grammar`).
 *
 * The model surface (stated, assumed, unclear, query, constraint, unparsed and the clause links) lives in `sop/enums.mjs`
 * and `sop/parser.mjs`; the words both surfaces share are imported from there, never respelled.
 */
import {NUMERIC_FIELDS, NUMERIC_FEATURE, NUMERIC_ARG_TYPE} from './numeric-action.mjs';
import {COMPARATOR_WORDS, ARITHMETIC_WORDS, COMPUTE_WORDS, INTEGER_COMPUTE_WORDS, ORDER_WORDS, ROLE_NAMES, COPULA_READINGS, LINK_WORDS, QUERY_MODES as MODEL_QUERY_MODES, REASONING_QUERY_MODES} from '../enums.mjs';

/** Words of the condition leaves; the model language and the knowledge language share these tables (sop/enums.mjs). */
export const COMPARATORS = Object.keys(COMPARATOR_WORDS);
export const ARITHMETIC = Object.keys(ARITHMETIC_WORDS);
export const COMPUTE = [...COMPUTE_WORDS];
export const INTEGER_COMPUTE = [...INTEGER_COMPUTE_WORDS];
export {ORDER_WORDS, ROLE_NAMES, COPULA_READINGS};
/** Every query mode of the knowledge grammar: the five of the model language and the five reasoning modes of DS004. */
export const QUERY_MODES = [...MODEL_QUERY_MODES, ...REASONING_QUERY_MODES];
export const MAX_ARITY = 6;
/** Parts of speech of a lexeme (DS004 "Lexicon wires"). */
export const LEXEME_POS = ['verb', 'noun', 'adj', 'prep', 'copula'];
/** Language codes of labels, aliases and lexemes: two or three lowercase letters. */
export const LANGUAGE_CODE = /^[a-z]{2,3}$/;
/** The class every entity belongs to when its `kind` is absent, and the kind of a class symbol. */
export const ROOT_CLASS = 'entity';
export const CLASS_KIND = 'class';
export const RESERVED_PREFIX = 'x_';
export const FEATURES = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'recursion', 'conjunction', 'exists', 'every', 'every_grouped', 'count', 'explain', 'used', 'why_not', 'temporal', 'interval', 'throughout', 'snapshot_derived', 'whatif', 'epistemic_status', 'naf', 'closed_world', 'closed_derived', 'compare_in_rules', 'compute_in_rules', 'aggregate', 'default', 'overrides', 'strict_contrary', 'integrity', 'constraint', 'optimize', 'plan', 'blocked_info', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'abduce', 'abduce_waive', 'zero_arity', 'budget', 'budget_probes', 'retrieval', 'versions', 'time_vars', 'binding_advisory', 'norm_conflict', 'conform_asof', 'conform_deviation', 'code_sandbox', 'exact_arithmetic', 'compute_in_recursion', 'effect', 'candidate', NUMERIC_FEATURE];
export const STEP_BLOCKS = ['choose', 'any_order', 'if', 'until'];
export const LINK_KEYWORDS = [...LINK_WORDS];
export const HOST_WRITTEN = ['approval', 'approved_by', 'approved_at'];
export const BUDGET_KEYS = ['maxNodes', 'maxDepth', 'maxHypotheses', 'maxCandidates', 'maxPlans', 'maxRounds', 'maxFacts', 'maxJoins', 'maxAssignments', 'maxFanout', 'timeoutMs'];
export const TEST_KINDS = ['example', 'property', 'generated', 'sealed'];
export const CODE_LANGUAGES = ['javascript'];
/** Parts of a `reply` (DS023 "Conversation layer"), in the order they are joined: a prefix (a user instruction), the opening, the body, an aside (a drive), a follow-up question, the closing and a suffix; and `line`, a sentence of the answer renderer (sop/answer-text.mjs). */
export const REPLY_PARTS = ['prefix', 'opening', 'body', 'aside', 'follow_up', 'closing', 'suffix', 'line'];
/** A `{{slot}}` placeholder of a reply text. */
export const REPLY_SLOT = /\{\{([a-z][a-z0-9_]*)\}\}/g;
export const CODE_PRODUCERS = ['renderer', 'llm-agent', 'user', 'dream'];
export const ARG_TYPES = ['entity', 'integer', 'text', 'time', 'value', NUMERIC_ARG_TYPE];
const APPROVALS = ['proposed', 'approved', 'contested', 'rejected', 'superseded', 'retired'];

const one = (kind, extra = {}) => ({card: 'one', kind, ...extra});
const many = (kind, extra = {}) => ({card: 'many', kind, ...extra});
const req = spec => ({...spec, required: true});

/** Governance fields shared by the wires that bind behaviour (round 2): only `approved` wires bind. */
export const GOV = {version: one('posint'), supersedes: one('ref'), approval: one('enum', {values: APPROVALS}), approved_by: one('text'), approved_at: one('date'), retired_at: one('date'), scope: one('text'), quote: one('text')};

/** The grammar: wire type -> {role, status, doc, fields}. `status` is existing (kept), extended or new. */
export const GRAMMAR = {
  predicate: {
    status: 'existing, extended', side: 'knowledge',
    doc: 'Declares a relation: arguments as role:type in args and/or as role NAME TYPE lines (a type is a value type entity integer text time value, or the class symbol an entity argument belongs to; both spellings must agree), display labels per language (a label is also a link form with the natural frame), closed-world flag, optional key position (lint), advisory routing hints (transitive, inverse), unit and the copula readings the relation carries (reading, describe_rank).',
    fields: {args: one('argtypes'), role: many('roletype'), label: many('langtext'), domain: one('sym'), closed: one('bool'), key: one('int'), transitive: one('bool'), inverse: one('sym'), unit: one('text'), description: one('text'), reading: many('enum', {values: COPULA_READINGS}), describe_rank: one('posint')}
  },
  lexeme: {
    status: 'new', side: 'knowledge',
    doc: 'One lexicalization of one predicate: the relation phrases (model-language convention: the lemma with its particles and prepositions, the copula included for copular phrases) in one language, the part of speech, and the roles the surface realizes in order (the grammatical subject first; a converse lists the object role first). A restrict line limits the form to values of a class; two predicates that share a form with the same frame must declare restrict or distinct weights.',
    fields: {of: req(one('sym')), language: req(one('langcode')), pos: one('enum', {values: LEXEME_POS}), form: req(many('phrase')), frame: req(one('rolelist')), restrict: many('restrict'), weight: one('int'), source: one('text'), quote: one('text')}
  },
  entity: {
    status: 'new', side: 'knowledge',
    doc: 'A reviewed identity: its class (kind, a class symbol; absent means the root class entity), one label per language and any number of aliases (inflected forms, abbreviations) that mentions resolve through. A class is an entity of kind class; class membership is also read from is_a facts. notability (an integer the memory supplies, for example the number of Wikipedia editions) only decides at build time which namesake keeps the plain label.',
    fields: {kind: one('sym'), label: many('langtext'), alias: many('langtext'), domain: one('sym'), notability: one('int'), source: one('text')}
  },
  fact: {
    status: 'existing, extended', side: 'knowledge',
    doc: 'One ground claim with validity, epistemic status, speaker, source and quote.',
    fields: {holds: req(one('groundnatom')), valid: one('time'), status: one('enum', {values: ['observed', 'reported', 'hedged', 'supposed']}), speaker: one('text'), source: one('text'), quote: one('text')}
  },
  rule: {
    status: 'existing, extended', side: 'knowledge',
    doc: 'Definite implication; the body is a condition group (atoms, not, absent, compare, compute, order, start_of, end_of, all/any).',
    fields: {when: req(many('cond')), then: req(one('natom')), mode: one('enum', {values: ['logical', 'causal']}), valid: one('time'), source: one('text'), ...GOV}
  },
  default: {
    status: 'new', side: 'knowledge',
    doc: 'Defeasible rule: applies unless an exception holds, a strict contrary is derived, or an overriding default fires.',
    fields: {when: req(many('cond')), then: req(one('natom')), except: many('cond'), priority: one('int'), overrides: many('ref'), source: one('text'), ...GOV}
  },
  integrity: {
    status: 'new', side: 'knowledge',
    doc: 'A pattern that must never hold in a state; each match derives violation ID WITNESS (arity 2), never an explosion.',
    fields: {never: req(many('cond')), witness: req(one('vars')), message: one('text'), severity: one('enum', {values: ['error', 'warning']}), source: one('text'), ...GOV}
  },
  reply: {
    status: 'new (conversation layer)', side: 'knowledge',
    doc: 'One phrasing of the assistant for a situation of a turn (DS023 "Conversation layer"): the situation symbol it serves, the part of the reply (prefix, opening, body, aside, follow_up, closing, suffix, or a line of the answer renderer), the language and the text with {{slot}} placeholders the renderer fills from the result packet. Several reply wires of one situation are variants. Data for the renderer, never evidence: the reasoning engines ignore it; the conversation layer reads it as facts reply_for, reply_part and reply_language.',
    fields: {situation: req(one('sym')), part: one('enum', {values: REPLY_PARTS}), language: one('langcode'), text: req(one('replytext')), source: one('text')}
  },
  aggregate: {
    status: 'new', side: 'knowledge',
    doc: 'Defines a derived relation by grouping a condition group and applying count, sum, min, max or collect.',
    fields: {over: req(many('cond')), group: one('vars'), count: one('aggspec'), sum: one('aggspec'), min: one('aggspec'), max: one('aggspec'), collect: one('aggspec'), yields: req(one('atom'))}
  },
  constraint: {
    status: 'existing (words-only form)', side: 'both',
    doc: 'Finite or numeric arithmetic problem: variables, requirements, claim, objective.',
    fields: {var: many('vardecl'), require: many('cmp'), claim: one('cmp'), objective: one('expr'), direction: one('enum', {values: ['min', 'max']}), task: one('enum', {values: ['prove', 'possible', 'optimize']}), select: one('vars'), unit: one('text')}
  },
  action: {
    status: 'existing', side: 'knowledge',
    doc: 'STRIPS-style state transition: preconditions, add and remove effects, cost, and optionally exact-rational numeric next/guard lines (extension E2). Governed like a method (round 3): preconditions and effects come from the manual and are amended the same way.',
    fields: {params: one('vars'), requires: req(many('natom')), adds: many('natom'), removes: many('natom'), cost: one('int'), source: one('text'), ...NUMERIC_FIELDS.action, ...GOV}
  },
  method: {
    status: 'new, extended in round 2', side: 'knowledge',
    doc: 'Procedure for a task: guard, then steps (primitive, sub-task, achieve, optional, choose, any_order, if/else, until with max, pick), preference, failure handling, binding and governance.',
    fields: {achieves: req(one('atom')), when: many('cond'), step: req(many('step')), prefer: many('prefer'), on_failure: one('onfail'), triggered_by: one('atom'), binding: one('enum', {values: ['strict', 'advisory']}), cost: one('int'), source: one('text'), ...GOV}
  },
  norm: {
    status: 'new (round 2)', side: 'knowledge',
    doc: 'Deontic rule over actions or states: forbid, oblige or permit a pattern, with condition, one temporal qualifier, severity, overrides and governance.',
    fields: {forbid: one('normpat'), oblige: one('normpat'), permit: one('normpat'), when: many('cond'), within: one('posint'), before: one('stepref'), after: one('stepref'), always: one('flag'), sometime: one('flag'), at_most_once: one('flag'), standing: one('flag'), severity: one('enum', {values: ['hard', 'soft']}), cost: one('posint'), priority: one('int'), overrides: many('ref'), binding: one('enum', {values: ['strict', 'advisory']}), message: one('text'), source: one('text'), ...GOV}
  },
  procedure: {
    status: 'new (round 2)', side: 'knowledge',
    doc: 'A named bundle of wires (a mode of work, or an analysis procedure applied to a document layer): members, scope, description, and report lines (proposal P-8): atom patterns whose rows are what the procedure reports (an analysis procedure without report lines reports the violations of its integrity members). It has no approval of its own; the members carry approval.',
    fields: {members: req(many('reflist')), description: one('text'), scope: one('text'), source: one('text'), report: many('atom')}
  },
  amendment: {
    status: 'new (round 2)', side: 'knowledge',
    doc: 'A proposed change to a procedure or wire: proposed member wires (approval proposed, usually superseding a version), removals, reason and review state.',
    fields: {of: req(one('ref')), proposed_by: req(one('enum', {values: ['user', 'agent']})), members: many('reflist'), removes: many('reflist'), reason: one('text'), approval: one('enum', {values: ['proposed', 'approved', 'rejected']}), evaluated: one('text')}
  },
  argument: {
    status: 'new (round 2)', side: 'knowledge',
    doc: 'A reason for or against a wire or amendment, with source and optional cost delta; evidence for the negotiation, never evidence of facts.',
    fields: {for: one('ref'), against: one('ref'), claim: req(one('text')), source: one('text'), cost_delta: one('int')}
  },
  trace: {
    status: 'new (round 2)', side: 'both',
    doc: 'A performed sequence of ground action steps, the input of mode conform. A step may end with "at DATE" (round 3): it is then judged against the versions in force at that date.',
    fields: {step: req(many('groundstep'))}
  },
  goal: {
    status: 'existing', side: 'knowledge',
    doc: 'A desired conjunction for planning.',
    fields: {where: req(many('cond'))}
  },
  hypothesis: {
    status: 'existing, extended', side: 'knowledge',
    doc: 'A candidate assumption for abduction or what-if (an atom, or waive a norm at a cost); never evidence.',
    fields: {holds: one('groundatom'), assume: many('groundatom'), waive: many('ref'), cost: one('int'), status: one('enum', {values: ['untested', 'supported', 'rejected']}), source: one('text')}
  },
  policy: {
    status: 'existing, extended', side: 'host',
    doc: 'Host budget and mode of work: resource limits only tighten; effort, partial answers, context scope tags, procedures in force (methods and rendered set), objective and default binding.',
    fields: {...Object.fromEntries(BUDGET_KEYS.map(k => [k, one('posint')])), effort: one('enum', {values: ['quick', 'normal', 'deep']}), partial: one('enum', {values: ['allow', 'forbid']}), procedures: many('ref'), scope: many('text'), objective: one('enum', {values: ['cost', 'violations', 'lexicographic']}), binding: one('enum', {values: ['strict', 'advisory']})}
  },
  stated: {
    status: 'existing (model surface)', side: 'query',
    doc: 'Model-surface supposition used by if/unless links of a query (what-if).',
    fields: {relation: req(one('text')), role: many('role'), polarity: one('enum', {values: ['affirmed', 'negated']}), valid: one('text'), certainty: one('enum', {values: ['asserted', 'hedged', 'supposed']}), speaker: one('text')}
  },
  query: {
    status: 'existing, extended', side: 'query',
    doc: 'The question. Modes select, exists, count, explain, every are existing; why_not, plan, abduce, conform and procedure are new; effect (Q-LANG-10) classifies each candidate against a ground claim; candidate names a supposed fact or a rule/default that is in force only in the runs of this query (modes effect and abduce); time is at (instant), during (throughout), overlaps (some instant), asof (known at).',
    fields: {
      where: many('cond'), select: one('vars'), mode: one('enum', {values: QUERY_MODES}), scope: many('cond'), at: one('instant'), during: one('interval'), overlaps: one('interval'), asof: one('instant'),
      trace: one('ref'), via: many('viastep'),
      compare: many('compareline'), order: many('orderline'), rank: one('text'), filter: many('text'), measure: one('enum', {values: ['start', 'end', 'duration']}),
      quantifier: one('quantifier', {values: ['all', 'none', 'not_all', 'most', 'half', 'at_least']}), except: many('text'), limit: one('posint'), policy: one('ref'), candidate: many('ref'),
      ...NUMERIC_FIELDS.query,
      ...Object.fromEntries(LINK_KEYWORDS.map(k => [k, many('ref')]))
    }
  },
  test: {
    status: 'new (programming, P0)', side: 'host',
    doc: 'One executable check of a program (host or turn wire, never on the model surface, never evidence): a call expression and the expected value expression, run by the code-sandbox strategy. A test of kind sealed never leaves eval/suites/ and is refused in every other file.',
    fields: {of: req(one('sym')), call: req(one('text')), expect: req(one('text')), kind: one('enum', {values: TEST_KINDS}), timeout: one('posint'), source: one('text')}
  },
  code: {
    status: 'new (programming, P0)', side: 'host',
    doc: 'A program for a task (host or turn wire, never on the model surface): language, entry function and body text, with its producer. Opaque to every engine; it runs only in the code-sandbox strategy. A verified body may become a library component through a host write.',
    fields: {of: req(one('sym')), language: req(one('enum', {values: CODE_LANGUAGES})), entry: req(one('ident')), body: req(one('text')), produced_by: one('enum', {values: CODE_PRODUCERS}), ...GOV}
  },
  pack: {
    status: 'existing', side: 'host', doc: 'Bundles values (host plumbing; not a knowledge wire).', fields: {items: req(many('ref'))}
  }
};

export function grammarMarkdown() {
  const rows = ['| wire type | status | essence | fields (`*` required, `+` repeatable) |', '| --- | --- | --- | --- |'];
  for (const [name, g] of Object.entries(GRAMMAR)) {
    const hasGov = Object.keys(GOV).every(k => k in g.fields);
    const fields = Object.entries(g.fields).filter(([k]) => !(name === 'query' && LINK_KEYWORDS.includes(k)) && !(name === 'policy' && BUDGET_KEYS.includes(k)) && !(hasGov && k in GOV)).map(([k, s]) => k + (s.required ? '*' : '') + (s.card === 'many' ? '+' : '')).join(', ');
    const extra = (name === 'query' ? ', link keywords (' + LINK_KEYWORDS.join(' ') + ')' : name === 'policy' ? ', ' + BUDGET_KEYS.join(' ') : '') + (hasGov ? ', governance (' + Object.keys(GOV).join(' ') + ')' : '');
    rows.push('| `' + name + '` | ' + g.status + ' | ' + g.doc + ' | ' + fields + extra + ' |');
  }
  return rows.join('\n');
}

/** The same grammar as a compact list for the authoring guide (`--grammar-compact`): one line per wire type, fields with * required and + repeatable. */
export function grammarCompact({only = null} = {}) {
  const lines = [];
  for (const [name, g] of Object.entries(GRAMMAR)) {
    if (only && !only.includes(name)) continue;
    const hasGov = Object.keys(GOV).every(k => k in g.fields);
    const fields = Object.entries(g.fields).filter(([k]) => !(name === 'query' && LINK_KEYWORDS.includes(k)) && !(name === 'policy' && BUDGET_KEYS.includes(k)) && !(hasGov && k in GOV)).map(([k, s]) => k + (s.required ? '*' : '') + (s.card === 'many' ? '+' : '')).join(' ');
    lines.push('- `@id ' + name + '`: ' + fields + (hasGov ? ' + governance' : ''));
  }
  lines.push('- governance = ' + Object.keys(GOV).join(' '));
  return lines.join('\n');
}
