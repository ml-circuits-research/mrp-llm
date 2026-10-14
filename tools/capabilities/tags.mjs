/**
 * Capability tags of a circuit, read by PARSING it with the product parsers (never by grepping names): the knowledge parser and
 * validator of `sop/knowledge/` for knowledge and query circuits, the model-surface parser `sop/parser.mjs` for what the formalizer
 * writes, and the StrategyRouter's feature reader (`reasoning/router/features.mjs`) for the compiled program (recursion, negation as
 * failure, aggregates, exact arithmetic...). The tag vocabulary is the one of the capability inventory (`tools/capabilities/inventory.mjs`):
 *
 *   k.wire.T  k.field.T.F  k.enum.T.F.V        knowledge wire types, fields and closed field values (sop/knowledge/grammar.mjs)
 *   k.leaf.L  k.group.G  k.step.B  k.term.K     condition leaves (atom, not, absent, compare.W, compute.W, order.W, start_of, end_of, match),
 *                                              Boolean groups, method step blocks, term kinds (decimal, string, zero_arity)
 *   k.word.query.F.W                           word fields of a knowledge query (compare, rank, quantifier, order)
 *   k.feature.F                                strategy features the compiled program needs (the router's `required` list)
 *   m.wire.T  m.field.T.F  m.enum.T.F.V         model-surface wire types, fields and closed values (sop/parser.mjs SPEC, sop/enums.mjs)
 *   m.role.R  m.polarity.P  m.word.T.F.W        roles and polarities of propositions, words of compare/rank/quantifier/order/require lines
 *   m.session.T                                session definitions (predicate, rule, default, aggregate) in a formalizer output
 *   x.A×B.a.b                                  LOCAL combination cells the tagger reads from one construct (negation × closedness of the
 *                                              negated predicate, compute word × decimal operand, compute × recursive stratum, link × certainty)
 *
 * Program-level combination cells (two tags in the same program) are derived from the tag set by `combinationCells`.
 */
import {parse as parseKnowledge, validateWires, GRAMMAR, leaves, tokens, DECIMAL, VAR} from '../../sop/knowledge/index.mjs';
import {parse as parseModel, SPEC, words, isMatch, parseMatch} from '../../sop/parser.mjs';
import {parseCondition as parseModelCondition} from '../../sop/conditions.mjs';
import {enumValues} from './checks.mjs';
import {ENUMS, LINK_WORDS, LINK_KEYWORDS} from '../../sop/enums.mjs';
import {MODEL_TYPES} from '../../sop/declarative.mjs';
import {circuitFeatures} from '../../reasoning/router/features.mjs';

const SESSION_TYPES = ['predicate', 'rule', 'default', 'aggregate'];
const f1 = (w, k) => w.fields.find(f => f.key === k)?.value.trim();

/** Tags of a knowledge circuit pair (knowledge text, query text). Unparsable text yields the tags it can still read. */
export function knowledgeTags(knowledge = '', query = '') {
  const tags = new Set();
  const kp = parseKnowledge(knowledge ?? ''), qp = parseKnowledge(query ?? '');
  const wires = [...kp.wires, ...qp.wires];
  // the validator attaches the parsed condition trees (w.conds) and aggregate specs; its problems are not ours to report here
  validateWires(wires, {role: 'any'});
  const closed = new Map();
  for (const w of wires) if (w.type === 'predicate') closed.set(w.id, f1(w, 'closed') === 'true');
  for (const w of wires) {
    const g = GRAMMAR[w.type];
    if (!g) continue;
    tags.add('k.wire.' + w.type);
    for (const f of w.fields) {
      const spec = g.fields[f.key];
      if (!spec) continue;
      tags.add(`k.field.${w.type}.${f.key}`);
      if (spec.values?.includes(tokens(f.value)[0])) tags.add(`k.enum.${w.type}.${f.key}.${tokens(f.value)[0]}`);
      if (spec.kind === 'bool') tags.add(`k.enum.${w.type}.${f.key}.${f.value.trim()}`);
      if (w.type === 'query') queryWordTags(f, tags);
      if (spec.kind === 'step') for (const line of [f.value, ...f.block.map(b => b.text)]) { const head = tokens(line)[0]; if (['choose', 'any_order', 'if', 'until', 'optional', 'achieve', 'pick'].includes(head)) tags.add('k.step.' + head); }
      if (['atom', 'groundatom', 'natom', 'groundnatom'].includes(spec.kind)) termTags(tokens(f.value), tags, f.value.trim().startsWith('not ') ? 'not' : null, closed);
    }
    for (const c of w.conds ?? []) condTags(c.tree, tags, closed);
  }
  for (const w of wires) if (w.type === 'fact' && f1(w, 'status')) tags.add('k.enum.fact.status.' + f1(w, 'status'));
  // what the compiled program needs: the router reads the same compiled program as the engines
  const queryWire = qp.wires.find(w => w.type === 'query');
  if (queryWire || qp.wires.some(w => w.type === 'constraint')) {
    try {
      const features = circuitFeatures({wires: kp.wires}, qp.wires);
      for (const r of features.required ?? []) tags.add('k.feature.' + r);
      if (features.recursion) {
        tags.add('k.feature.recursion');
        for (const t of [...tags]) if (t.startsWith('k.leaf.compute.') && features.compute_in_recursion) tags.add('x.compute×recursion.' + t.slice('k.leaf.compute.'.length) + '.recursive');
      }
      if (features.nonlinear) tags.add('k.feature.nonlinear_recursion');
    } catch { /* an invalid program has no compiled features */ }
    for (const [feature, test] of SYNTAX_FEATURES) if (test(tags, wires)) tags.add('k.feature.' + feature);
  }
  return tags;
}

/**
 * Strategy features (sop/knowledge/grammar.mjs FEATURES) read from the syntax of a program that asks a question, for the features the
 * router's `required` list does not name (it lists what routing needs, not everything a program uses).
 */
const has = (tags, ...xs) => xs.some(x => tags.has(x));
const prefixed = (tags, p) => [...tags].some(t => t.startsWith(p));
const fieldValue = (wires, type, key, value) => wires.some(w => w.type === type && w.fields.some(f => f.key === key && tokens(f.value)[0] === value));
const SYNTAX_FEATURES = [
  ['facts', t => has(t, 'k.wire.fact')], ['select', t => has(t, 'k.field.query.select')], ['conjunction', t => has(t, 'k.group.all') || [...t].length > 0 && has(t, 'k.wire.rule')],
  ['open_world', (t, w) => w.some(x => x.type === 'predicate' && f1(x, 'closed') !== 'true')], ['closed_world', t => has(t, 'k.enum.predicate.closed.true')],
  ['closed_derived', (t, w) => has(t, 'k.enum.predicate.closed.true') && has(t, 'k.wire.rule', 'k.wire.aggregate')],
  ['classical_negation', t => has(t, 'k.leaf.not')], ['conflict', t => has(t, 'k.leaf.not') && has(t, 'k.wire.fact')],
  ['compare_in_rules', t => prefixed(t, 'k.leaf.compare.')], ['compute_in_rules', t => prefixed(t, 'k.leaf.compute.')],
  ['overrides', t => has(t, 'k.field.default.overrides', 'k.field.norm.overrides')], ['strict_contrary', (t, w) => has(t, 'k.wire.default') && has(t, 'k.wire.rule')],
  ['whatif', t => has(t, 'k.enum.fact.status.supposed', 'k.field.query.if')], ['epistemic_status', t => prefixed(t, 'k.enum.fact.status.')],
  ['zero_arity', t => has(t, 'k.term.zero_arity')], ['time_vars', t => has(t, 'k.leaf.start_of', 'k.leaf.end_of')], ['interval', t => has(t, 'k.field.query.during', 'k.field.query.overlaps')],
  ['throughout', t => has(t, 'k.field.query.during')], ['snapshot_derived', t => has(t, 'k.field.query.at') && has(t, 'k.wire.rule')],
  ['every_grouped', t => has(t, 'k.enum.query.mode.every') && has(t, 'k.field.query.select')], ['optimize', t => has(t, 'k.enum.constraint.task.optimize')],
  ['versions', t => has(t, 'k.field.rule.version', 'k.field.rule.supersedes', 'k.field.query.asof')], ['budget', (t, w) => w.some(x => x.type === 'policy')],
  ['method', t => has(t, 'k.wire.method')], ['htn_choice', t => has(t, 'k.step.choose')], ['on_failure', t => has(t, 'k.field.method.on_failure')],
  ['norms_hard', (t, w) => has(t, 'k.wire.norm') && !fieldValue(w, 'norm', 'severity', 'soft')], ['norms_soft', t => has(t, 'k.enum.norm.severity.soft')],
  ['temporal_norms', t => has(t, 'k.field.norm.within', 'k.field.norm.before', 'k.field.norm.after', 'k.field.norm.always', 'k.field.norm.sometime', 'k.field.norm.at_most_once')],
  ['procedures', t => has(t, 'k.wire.procedure', 'k.enum.query.mode.procedure')], ['procedure_render', t => has(t, 'k.enum.query.mode.procedure')], ['amendment', t => has(t, 'k.wire.amendment')],
  ['abduce_waive', t => has(t, 'k.field.hypothesis.waive')], ['binding_advisory', t => has(t, 'k.enum.norm.binding.advisory', 'k.enum.method.binding.advisory')],
  ['conform_asof', t => has(t, 'k.enum.query.mode.conform') && has(t, 'k.field.query.asof')], ['code_sandbox', t => has(t, 'k.wire.code')], ['numeric_action', t => has(t, 'k.field.action.next', 'k.field.query.observe')]
];

function queryWordTags(f, tags) {
  const t = tokens(f.value);
  if (f.key === 'quantifier' && t[0]) tags.add('k.word.query.quantifier.' + t[0]);
  if (f.key === 'rank' && t[0]) { tags.add('k.word.query.rank.' + t[0]); if (['position', 'top'].includes(t[2])) tags.add('k.word.query.rank.' + t[2]); }
  if (f.key === 'order' && t.length === 1) tags.add('k.word.query.order.' + t[0]);
  if (f.key === 'compare') for (const line of [f.value, ...f.block.map(b => b.text)]) { const w = tokens(line)[1]; if (w && /^[a-z_]+$/.test(w)) tags.add('k.word.query.compare.' + w); }
}

function termTags(toks, tags, neg, closed) {
  const terms = toks.filter(t => !['not', 'absent'].includes(t)).slice(1);
  if (toks.length && !terms.length) tags.add('k.term.zero_arity');
  for (const t of terms) {
    if (DECIMAL.test(t)) tags.add('k.term.decimal');
    if (t.startsWith('"')) tags.add('k.term.string');
  }
  if (neg) tags.add('k.leaf.' + neg);
}

function condTags(node, tags, closed) {
  if (!node) return;
  if (node.kind === 'all' || node.kind === 'any') { tags.add('k.group.' + node.kind); for (const c of node.children) condTags(c, tags, closed); return; }
  switch (node.kind) {
    case 'atom': {
      tags.add('k.leaf.atom');
      if (node.terms.length === 0) tags.add('k.term.zero_arity');
      for (const t of node.terms) { if (DECIMAL.test(t)) tags.add('k.term.decimal'); if (t.startsWith('"')) tags.add('k.term.string'); }
      if (node.neg === 'not' || node.neg === 'absent') {
        tags.add('k.leaf.' + node.neg);
        tags.add(`x.negation×closedness.${node.neg}.${closed.get(node.p) ? 'closed' : 'open'}`);
      }
      break;
    }
    case 'compare': tags.add('k.leaf.compare.' + node.word); if ([node.left, node.right].some(t => DECIMAL.test(t))) tags.add('k.term.decimal'); break;
    case 'compute': {
      tags.add('k.leaf.compute.' + node.word);
      const decimal = [node.left, node.right].some(t => DECIMAL.test(t));
      if (decimal) tags.add('k.term.decimal');
      tags.add(`x.compute×number.${node.word}.${decimal ? 'decimal' : 'integer'}`);
      break;
    }
    case 'order': tags.add('k.leaf.order.' + node.word); break;
    case 'timeof': tags.add('k.leaf.' + node.which); break;
    case 'match': tags.add('k.leaf.match'); break;
    default: break;
  }
}

/** Tags of a model-surface circuit (what the formalizer writes). Session definitions are tagged by the knowledge tagger too. */
export function modelTags(text) {
  const tags = new Set();
  // session definitions (predicate, default, aggregate) are knowledge wires the model parser does not read: they are tagged apart
  const chunks = text.split(/\n(?=@)/).map(c => c.trim()).filter(Boolean);
  const typeOf = c => /^@\S+\s+(\S+)/.exec(c)?.[1];
  const sessionChunks = chunks.filter(c => SESSION_TYPES.includes(typeOf(c)));
  for (const c of sessionChunks) tags.add('m.session.' + typeOf(c));
  if (sessionChunks.length) for (const t of knowledgeTags(sessionChunks.join('\n\n') + '\n', '')) tags.add(t);
  let program;
  try { program = parseModel(chunks.filter(c => !SESSION_TYPES.includes(typeOf(c))).join('\n\n') + '\n', {maxWires: 4096}); } catch { return tags; }
  const byId = new Map(program.wires.map(w => [w.id, w]));
  for (const w of program.wires) {
    if (!MODEL_TYPES.has(w.type)) continue;
    tags.add('m.wire.' + w.type);
    for (const [key, values] of Object.entries(w.fields)) {
      tags.add(`m.field.${w.type}.${key}`);
      const allowed = enumValues(w.type, key);
      for (const v of values) {
        const head = words(v)[0];
        if (allowed?.includes(v.trim())) tags.add(`m.enum.${w.type}.${key}.${v.trim()}`);
        else if (allowed?.includes(head)) tags.add(`m.enum.${w.type}.${key}.${head}`);
        if (LINK_WORDS.includes(key)) {
          const target = byId.get(v.trim().slice(1));
          const certainty = target?.type === 'stated' ? target.fields.certainty?.[0] : target?.type ?? 'missing';
          tags.add(`x.link×certainty.${key}.${certainty}`);
        }
        modelWordTags(w, key, v, tags);
      }
    }
    if (w.type === 'stated' || w.type === 'assumed') {
      for (const r of w.fields.role ?? []) { const name = words(r)[0]; if (name) tags.add('m.role.' + name); }
      for (const p of w.fields.polarity ?? []) tags.add('m.polarity.' + p.trim());
    }
    if (w.type === 'query') for (const text of [...(w.fields.where ?? []), ...(w.fields.scope ?? [])]) {
      try {
        parseModelCondition(text, leaf => {
          if (isMatch(leaf)) {
            tags.add('m.match');
            const p = parseMatch(leaf, 'match', {partial: true});
            for (const r of p.roles) { tags.add('m.role.' + r.name); if (typeof r.value === 'string' && r.value.startsWith('?')) tags.add('m.role_variable.' + r.name); }
            if (p.polarity) tags.add('m.polarity.' + p.polarity);
          } else tags.add('m.atom_leaf');
          return leaf;
        });
        if (/^(all|any)\n/.test(text)) tags.add('m.group.' + text.slice(0, 3).trim());
      } catch { /* the validator reports it */ }
    }
  }
  return tags;
}

function modelWordTags(w, key, value, tags) {
  const t = words(value);
  if (w.type === 'query') {
    if (key === 'compare') for (const line of value.split('\n')) { const x = words(line)[1]; if (x && /^[a-z_]+$/.test(x)) tags.add('m.word.query.compare.' + x); }
    if (key === 'rank') { tags.add('m.word.query.rank.' + t[0]); if (t[2]) tags.add('m.word.query.rank.' + t[2]); }
    if (key === 'quantifier') tags.add('m.word.query.quantifier.' + t[0]);
    if (key === 'order') tags.add('m.word.query.order.' + (t.length === 1 ? t[0] : t[1]));
    if (key === 'limit') tags.add('m.word.query.limit');
  }
  if (w.type === 'constraint' && ['require', 'claim', 'objective'].includes(key)) for (const x of value.split(/\s+/)) if (/^(above|below|at_least|at_most|equal|not_equal|plus|minus|times|divided_by)$/.test(x)) tags.add('m.word.constraint.' + x);
}

/** Tags of any circuit: `{knowledge, query}` (knowledge language) or `{text}` (either surface; the model surface is tried first). */
export function circuitTags(circuit) {
  if (circuit.knowledge !== undefined || circuit.query !== undefined) return knowledgeTags(circuit.knowledge ?? '', circuit.query ?? '');
  const text = circuit.text ?? '';
  const types = [...text.matchAll(/^@\S+\s+(\S+)\s*$/gm)].map(m => m[1]);
  const model = types.some(t => MODEL_TYPES.has(t)) && !types.some(t => ['fact', 'integrity', 'action', 'method', 'norm', 'hypothesis', 'trace', 'goal', 'policy'].includes(t));
  const queryHasAtoms = /^@\S+\s+query\s*$/m.test(text) && !/^\s+match\s*$/m.test(text) && !/^\s+where\s+match\s*$/m.test(text);
  if (model && !queryHasAtoms) {
    const tags = modelTags(text);
    if (tags.size) return tags;
  }
  // knowledge language: split query-side wires (query, constraint, supposed facts, policy) from the knowledge side
  const chunks = text.split(/\n(?=@)/);
  const isQuery = c => /^@\S+\s+(query|constraint|policy)\s*$/m.test(c.trim().split('\n')[0]) || (/^@\S+\s+fact\s*$/m.test(c.trim().split('\n')[0]) && /\n\s+status\s+(supposed|hedged)/.test(c));
  return knowledgeTags(chunks.filter(c => !isQuery(c)).join('\n'), chunks.filter(isQuery).join('\n'));
}

export {LINK_KEYWORDS};
