import {parse, parseCondition, atomFrom, tokens} from '../../sop/knowledge/lexical.mjs';
import {GRAMMAR} from '../../sop/knowledge/grammar.mjs';
import {Lowering, factWire} from '../bridge/lower.mjs';

const lower = new Lowering();
const supported = new Set(['predicate', 'fact', 'rule', 'default', 'aggregate', 'integrity', 'entity', 'lexeme']);
const describe = value => tokens(value).map(t => t.startsWith('"') ? JSON.parse(t) : t).join(' ');
const field = (wire, key) => wire.fields.filter(f => f.key === key);
const one = (wire, key) => field(wire, key)[0]?.value?.trim();
const atom = text => {
  const a = atomFrom(tokens(text), {allowNeg: true, allowAbsent: true});
  if (a.error) throw new TypeError(`Cannot render atom ${JSON.stringify(text)}: ${a.error}`);
  const args = a.terms.map(t => t.startsWith('"') ? JSON.parse(t) : t).join(', ');
  const call = `${a.p}(${args})`;
  return a.neg === 'not' ? `explicitly not ${call}` : a.neg === 'absent' ? `no known ${call} in its complete list` : call;
};
const condition = node => {
  switch (node?.kind) {
    case 'all': case 'any': return '(' + node.children.map(condition).join(node.kind === 'all' ? ' AND ' : ' OR ') + ')';
    case 'atom': return atom([node.neg !== 'none' ? node.neg : '', node.p, ...node.terms].filter(Boolean).join(' '));
    case 'compare': return `${describe(node.left)} ${node.word.replaceAll('_', ' ')} ${describe(node.right)}`;
    case 'compute': return `compute ${node.out} as ${describe(node.left)} ${node.word.replaceAll('_', ' ')} ${describe(node.right)}`;
    case 'order': return `${node.left} ${node.word.replaceAll('_', ' ')} ${node.right}`;
    case 'timeof': return `${node.out} is the ${node.which === 'start_of' ? 'start' : 'end'} of ${atom([node.p, ...node.terms].join(' '))}`;
    case 'match': return `match ${node.relation ?? ''} with roles ${node.roles.map(r => `${r.name}=${describe(r.value)}`).join(', ')} and polarity ${node.polarity}`;
    default: throw new TypeError(`Unsupported condition kind ${JSON.stringify(node?.kind)}`);
  }
};
const conditions = (w, key) => field(w, key).map(f => {
  const problems = [];
  const tree = parseCondition(f, problems);
  if (problems.length) throw new TypeError(`Cannot render @${w.id} ${key}: ${problems[0].message}`);
  return condition(tree);
}).join(' AND ');
const detail = f => `${f.key.replaceAll('_', ' ')}: ${describe(f.value)}${f.block.length ? ' [block: ' + f.block.map(b => b.text).join('; ') + ']' : ''}`;
const time = w => {
  const validity = one(w, 'valid');
  if (!validity || validity === 'timeless') return '';
  const bounds = tokens(validity);
  if (bounds.length !== 2) throw new TypeError(`Invalid validity of @${w.id}: ${validity}`);
  return ` Valid from ${describe(bounds[0])} inclusive until ${describe(bounds[1])} exclusive.`;
};

function renderWire(w) {
  if (!w || typeof w.id !== 'string' || !Array.isArray(w.fields) || !supported.has(w.type))
    throw new TypeError(`Unsupported evidence wire @${w?.id ?? '?'} type ${JSON.stringify(w?.type)}`);
  const schema = GRAMMAR[w.type].fields;
  for (const f of w.fields) if (!Object.hasOwn(schema, f.key) || typeof f.value !== 'string' || !Array.isArray(f.block))
    throw new TypeError(`Unsupported evidence field @${w.id} ${f.key}`);
  for (const [key, spec] of Object.entries(schema))
    if (spec.required && !field(w, key).length) throw new TypeError(`Missing required evidence field @${w.id} ${key}`);
  const used = new Set();
  const use = (...keys) => keys.forEach(key => used.add(key));
  let sentence;
  switch (w.type) {
    case 'predicate': {
      use('args', 'role', 'closed');
      const args = one(w, 'args') ?? (field(w, 'role').map(f => f.value).join(', ') || 'none');
      sentence = `Relation ${w.id} has arguments ${describe(args)}. ${one(w, 'closed') === 'true' ? `The list of ${w.id} is complete.` : `The list of ${w.id} is not declared complete.`}`;
      break;
    }
    case 'fact':
      use('holds', 'valid', 'status');
      if (!one(w, 'holds')) throw new TypeError(`Missing @${w.id} holds`);
      sentence = `${one(w, 'status') ?? 'observed'} evidence: ${atom(one(w, 'holds'))}.${time(w)}`;
      break;
    case 'rule':
      use('when', 'then', 'valid', 'mode');
      sentence = `Strict ${one(w, 'mode') ?? 'logical'} rule: if ${conditions(w, 'when')}, then ${atom(one(w, 'then'))}.${time(w)}`;
      break;
    case 'default': {
      use('when', 'then', 'except', 'priority', 'overrides');
      const exception = field(w, 'except').length ? ` unless ${conditions(w, 'except')}` : '';
      const priority = one(w, 'priority') ? ` Priority ${one(w, 'priority')} (a firing default of higher priority defeats a contrary default; equal-strength contrary defaults can both hold).` : '';
      const overrides = field(w, 'overrides').length ? ` Overrides ${field(w, 'overrides').map(f => f.value.replace(/^\$/, '')).join(', ')} when it fires.` : '';
      sentence = `Normally, if ${conditions(w, 'when')}${exception}, conclude ${atom(one(w, 'then'))}; strict contrary evidence blocks this default.${priority}${overrides}`;
      break;
    }
    case 'aggregate': {
      use('over', 'group', 'count', 'sum', 'min', 'max', 'collect', 'yields');
      const operations = w.fields.filter(f => ['count', 'sum', 'min', 'max', 'collect'].includes(f.key)).map(f => `${f.key} ${describe(f.value)}`);
      if (!operations.length) throw new TypeError(`Missing aggregation in @${w.id}`);
      sentence = `Aggregate over ${conditions(w, 'over')}${one(w, 'group') ? ` grouped by ${describe(one(w, 'group'))}` : ''}: ${operations.join(', ')}; yields ${atom(one(w, 'yields'))}. Counts use distinct bindings; results are exact only over complete input lists.`;
      break;
    }
    case 'integrity':
      use('never', 'witness', 'message', 'severity');
      sentence = `Integrity constraint: never ${conditions(w, 'never')}; witness ${describe(one(w, 'witness'))}${one(w, 'severity') ? `; severity ${one(w, 'severity')}` : ''}${one(w, 'message') ? `; message ${describe(one(w, 'message'))}` : ''}. A match records a violation, not an explosion.`;
      break;
    case 'entity': case 'lexeme':
      sentence = `${w.type === 'entity' ? 'Entity' : 'Lexeme'} ${w.id}.`;
      break;
  }
  const extras = w.fields.filter(f => !used.has(f.key));
  return `[@${w.id}] ${sentence}${extras.length ? ` Other specified properties: ${extras.map(detail).join('; ')}.` : ''}`;
}

/** Deterministically render SOP knowledge, a Theory, or retrieved {facts, wires} into explicit English evidence. Unsupported wires fail closed. */
export function renderEnglish(input, options = {}) {
  if (options && Object.keys(options).length) throw new TypeError(`Unsupported renderer options: ${Object.keys(options).join(', ')}`);
  let wires = [];
  if (typeof input === 'string') {
    const parsed = parse(input);
    if (parsed.errors.length) throw new TypeError(`Invalid SOP evidence: ${parsed.errors[0].message}`);
    wires = parsed.wires;
  } else if (input && typeof input === 'object') {
    if (Array.isArray(input.wires)) wires = input.wires;
    else if (Array.isArray(input.recs) && Array.isArray(input.carry) && input.predicates instanceof Map) {
      if (input.storedFacts && !Array.isArray(input.facts)) throw new TypeError('Theory omits repository facts; pass {wires, facts} with retrieved facts instead');
      wires = [...input.predicates.values(), ...input.recs.map(r => r.wire), ...input.carry];
    }
    else if (!Array.isArray(input.facts)) throw new TypeError('Evidence requires wires, facts, a Theory or SOP text');
    if (input.facts !== undefined) {
      if (!Array.isArray(input.facts)) throw new TypeError('Evidence facts must be an array');
      wires = [...wires, ...input.facts.map((f, i) => {
        if (f?.type === 'fact') return f;
        if (!f?.atom || !Array.isArray(f.atom.a) || typeof f.atom.p !== 'string') throw new TypeError(`Unsupported typed fact at index ${i}`);
        return factWire(lower, f.id ?? `observed_${i + 1}`, f, f.kind === 'assumed' ? 'supposed' : f.status ?? 'observed');
      })];
    }
  } else throw new TypeError('Evidence requires SOP text, a Theory, or {facts, wires}');
  const unique = new Map();
  for (const w of wires) {
    const previous = unique.get(w?.id);
    if (previous) {
      const meaning = wire => JSON.stringify([wire.type, wire.fields?.map(f => [f.key, f.value, f.block?.map(b => b.text)])]);
      if (meaning(previous) !== meaning(w)) throw new TypeError(`Conflicting evidence for wire @${w.id}`);
    } else unique.set(w?.id, w);
  }
  return [...unique.values()].map(renderWire).join('\n');
}
