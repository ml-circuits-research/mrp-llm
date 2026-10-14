import {parseMatch, isMatch, many} from '../../sop/parser.mjs';
import {parseCondition} from '../../sop/conditions.mjs';
import {compileDeclarative} from '../../sop/declarative.mjs';
import {TheoryCache, termValue} from '../../reasoning/slice/wire.mjs';
import {RepositorySource} from '../../reasoning/slice/source.mjs';
import {conditionMisuses} from '../../reasoning/slice/condition-misuse.mjs';
import {StrategyRegistry} from '../../memory/strategies.mjs';
import {tokens, parse as parseKnowledge, parseCondition as knowledgeCondition, leaves} from '../../sop/knowledge/lexical.mjs';
import {predicateCircuits} from './session.mjs';

const theories = new TheoryCache();
const indexes = new WeakMap();
const variable = v => typeof v === 'string' && v.startsWith('?');
const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim();

function circuitSource(theory) {
  let index = indexes.get(theory);
  if (!index) {
    index = new Map();
    for (const w of theory.byId.values()) {
      if (w.type !== 'fact') continue;
      const t = tokens(field(w, 'holds') ?? ''), neg = t[0] === 'not', start = neg ? 1 : 0;
      const atom = {p: t[start], a: t.slice(start + 1).map(termValue), neg};
      const key = JSON.stringify([atom.p, atom.a.length, neg]);
      let entry = index.get(key);
      if (!entry) index.set(key, entry = {rows: [], positions: atom.a.map(() => new Map())});
      const row = {atom};
      entry.rows.push(row);
      atom.a.forEach((v, i) => {
        const values = entry.positions[i];
        if (!values.has(v)) values.set(v, []);
        values.get(v).push(row);
      });
    }
    indexes.set(theory, index);
  }
  return {lookup(pattern, {cap, probes}) {
    const entry = index.get(JSON.stringify([pattern.p, pattern.a.length, !!pattern.neg]));
    const position = pattern.a.findIndex(v => !variable(v));
    const rows = !entry ? [] : position < 0 ? entry.rows : entry.positions[position].get(pattern.a[position]) ?? [];
    const n = Math.min(rows.length, cap, probes);
    return {rows: rows.slice(0, n), probes: n, complete: n === rows.length, exact: true};
  }};
}

function phraseConditions(program, lexicon, message) {
  const plan = compileDeclarative(program.modelSop, {lexicon, schema: lexicon.predicates, inputText: message});
  if (plan.issues?.length || plan.unclear || plan.notComputable?.length) return {atoms: [], localWires: []};
  const parsed = parseKnowledge(plan.executionSop), bound = new Map();
  for (const w of parsed.wires.filter(w => w.type === 'resolve')) {
    const result = lexicon.resolve(JSON.parse(field(w, 'text')), {
      language: field(w, 'language'), kind: field(w, 'kind'), type: field(w, 'type')});
    if (result.status === 'bound') bound.set(w.id, result.id);
  }
  const resolve = token => token.startsWith('$') ? bound.get(token.slice(1)) : termValue(token);
  const atoms = [];
  for (const w of parsed.wires.filter(w => w.type === 'query')) {
    for (const f of w.fields.filter(f => ['where', 'scope'].includes(f.key))) {
      for (const leaf of leaves(knowledgeCondition(f, []))) {
        if (leaf.kind !== 'atom') continue;
        const a = leaf.terms.map(resolve);
        if (a.every(v => v !== undefined)) atoms.push({p: leaf.p, a, neg: leaf.neg === 'not', absent: leaf.neg === 'absent'});
      }
    }
  }
  const localWires = parseKnowledge(plan.executionSop.replace(/"(?:\\.|[^"\\])*"|\$[A-Za-z][A-Za-z0-9_]*/g,
    token => token.startsWith('$') && bound.has(token.slice(1)) ? JSON.stringify(bound.get(token.slice(1))) : token)).wires;
  return {atoms, localWires};
}

/** Names are linked without answers, guessed identities or inferred identifier classes. */
export function checkConditionUse({program, lexicon, circuits, repo, session, mode, message}) {
  if (!circuits?.length && !repo) return [];
  const phrase = mode === 'phrase' ? phraseConditions(program, lexicon, message) : null;
  const atoms = phrase?.atoms ?? [];
  for (const w of (phrase ? [] : program.wires.filter(w => w.type === 'query' && !w.fields.fragment))) {
    for (const text of [...many(w, 'where'), ...many(w, 'scope')]) parseCondition(text, leaf => {
      if (!isMatch(leaf)) return leaf;
      const block = parseMatch(leaf), schema = lexicon.predicates[block.relation];
      if (!schema?.roles?.length) return leaf;
      let unresolved = false;
      const a = schema.roles.map((role, i) => {
        const value = block.roles.find(r => r.name === role.name)?.value ?? `?domain${i}`;
        if (variable(value) || typeof value !== 'string' || ['integer', 'value'].includes(role.type)) return value;
        if (Object.hasOwn(lexicon.entities ?? {}, value)) return value;
        const resolved = lexicon.resolve?.(value, {kind: 'entity', language: 'en'});
        if (resolved?.status === 'bound') return resolved.id;
        unresolved = true;
        return value;
      });
      if (!unresolved) atoms.push({p: schema.id, a, neg: block.polarity === 'negated', absent: block.polarity === 'absent'});
      return leaf;
    });
  }
  if (!atoms.length) return [];
  const theory = theories.get([...circuits ?? predicateCircuits(lexicon), ...(program.definitionSop ? [{name: 'turn-definitions', text: program.definitionSop}] : [])]);
  const source = repo && session ? new RepositorySource({repo, session, registry: new StrategyRegistry(), strategy: 'hybrid', query: {asof: Infinity}}) : circuitSource(theory);
  return conditionMisuses({theory, atoms, source, lexicon, localWires: phrase?.localWires}).problems.map(p => ({...p,
    message: `${p.condition}: position ${p.position}${p.role ? ` (${p.role})` : ''} misuses ${JSON.stringify(p.value)} (${p.reason}); observed values: ${p.values.map(v => JSON.stringify(v)).join(', ') || 'none'}. Preserve the request; repair the condition, never answer.`}));
}
