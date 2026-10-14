/**
 * Circuits as data for dreaming: the query FAMILY (a query with its constants abstracted), the SCHEMA CONE (the contract of the rules
 * and predicates the query's answer can depend on; facts are not in it, so a plan survives new data), join-order candidates, and
 * the application of a deployment plan as a legal rewriting of the circuits. A rewriting only chooses among equivalent plans:
 * it permutes the order of positive atoms in a rule body, or adds a rule a skill proposes; the wrapped strategy still decides the answer.
 */
import {parse, selectInForce, desugar, wiresText, tokens} from '../../../sop/knowledge/index.mjs';
import {compileProgram, sliceProgram, conditionAlts} from '../js-reference/program.mjs';
import {hash} from './records.mjs';

const f1 = (w, k) => w.fields.find(f => f.key === k);

export class StaleSkillError extends Error {}

export function readWires(text) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new Error(`${errors[0].code}: ${errors[0].message}`);
  return wires;
}

/** `where` atoms with constants replaced by `_`: queries that differ only in constants are one family. */
export function familyOf(queryText) {
  const q = readWires(queryText).find(w => w.type === 'query');
  if (!q) return null;
  const shape = q.fields.filter(f => ['where', 'scope', 'mode', 'select'].includes(f.key)).map(f => `${f.key} ${tokens(f.value).map(t => (t.startsWith('?') || f.key !== 'where' ? t : '_')).join(' ')}${f.block?.length ? ' {' + f.block.map(b => b.text.split(/\s+/).map(t => (t.startsWith('?') ? t : '_')).join(' ')).join(';') + '}' : ''}`);
  return hash(shape.sort());
}

/**
 * The cone of a query in a theory: predicates reachable backwards through the rules, the rule and predicate wires over them, and the
 * contract hash of those wires' text. Returns null when the circuits are outside the core (the wrapper then passes the task through).
 */
export function coneOf(knowledgeText, queryText) {
  try {
    const wires = readWires(knowledgeText);
    const qWires = readWires(queryText);
    const q = qWires.find(w => w.type === 'query');
    const inForce = selectInForce(wires, {asof: null, include: []});
    const {wires: core, origin} = desugar([...inForce, ...qWires.filter(w => w.type === 'fact')]);
    const program = compileProgram(core, {origin});
    const seeds = conditionAlts(q.fields.filter(f => ['where', 'scope'].includes(f.key)), q.id).flatMap(alt => alt.filter(l => l.kind === 'atom' || l.kind === 'timeof').map(l => l.p));
    const {program: sliced} = sliceProgram(program, seeds);
    const preds = sliced.slice;
    const authored = inForce.filter(w => w.type !== 'fact' && ['predicate', 'rule', 'default', 'integrity', 'aggregate'].includes(w.type)
      && (w.type === 'predicate' ? preds.has(w.id) : headsOf(w).some(p => preds.has(p)) || w.type === 'default' || w.type === 'integrity'));
    const contract = hash(wiresText([...authored].sort((a, b) => (a.id < b.id ? -1 : 1))));
    return {preds, wires, program, contract, ruleIds: authored.filter(w => w.type === 'rule').map(w => w.id), factCounts: countFacts(program)};
  } catch {
    return null;
  }
}

function headsOf(w) {
  if (w.type === 'rule') return [tokens(f1(w, 'then').value).filter(t => t !== 'not')[0]];
  if (w.type === 'aggregate') return [tokens(f1(w, 'yields')?.value ?? '')[0]];
  return [];
}

function countFacts(program) {
  const c = new Map();
  for (const f of program.facts) c.set(f.p, (c.get(f.p) ?? 0) + 1);
  return c;
}

// ------------------------------------------------------------------------------------------------ join-order candidates

const isSimpleAtomField = f => f.key === 'when' && !f.block?.length && !/^(all|any|absent|compare|compute|order|start_of|end_of|not)\b/.test(f.value.trim()) && tokens(f.value).length > 0;

/** Greedy order of the positive atoms of a rule body by estimated candidate rows, binding variables left to right. */
export function joinOrder(rule, sizes, defaultSize) {
  const atoms = rule.fields.map((f, i) => ({f, i})).filter(({f}) => isSimpleAtomField(f));
  if (atoms.length < 3 || atoms.length !== rule.fields.filter(f => f.key === 'when').length) return null;
  const bound = new Set(), chosen = [], rest = [...atoms];
  const est = ({f}) => {
    const [p, ...terms] = tokens(f.value);
    let rows = sizes.get(p) ?? defaultSize;
    for (const t of terms) if (!t.startsWith('?') || bound.has(t)) rows /= 20;
    return Math.max(rows, 1);
  };
  while (rest.length) {
    rest.sort((a, b) => est(a) - est(b) || a.i - b.i);
    const next = rest.shift();
    chosen.push(next);
    for (const t of tokens(next.f.value).slice(1)) if (t.startsWith('?')) bound.add(t);
  }
  const order = chosen.map(x => x.i);
  return order.every((v, k) => v === atoms[k].i) ? null : {rule: rule.id, order, from: atoms.map(x => x.i), digest: hash(atoms.map(x => x.f.value))};
}

/** Candidate join-order skills of a cone: one per rule whose written order differs from the greedy one. */
export function joinCandidates(cone) {
  const total = [...cone.factCounts.values()].reduce((s, n) => s + n, 0) || 1;
  const out = [];
  for (const w of cone.wires) {
    if (w.type !== 'rule' || !cone.ruleIds.includes(w.id)) continue;
    const c = joinOrder(w, cone.factCounts, total);
    if (c) out.push(c);
  }
  return out;
}

/** Apply the skills of a deployment plan to knowledge wires; returns the rewritten knowledge text. */
export function applySkills(wires, skills) {
  const out = wires.map(w => ({...w, fields: [...w.fields]}));
  for (const s of skills) {
    if (s.kind === 'join_order') {
      const w = out.find(x => x.id === s.artifact.rule);
      if (!w) throw new StaleSkillError(`rule ${s.artifact.rule} is gone`);
      const slots = w.fields.map((f, i) => i).filter(i => w.fields[i].key === 'when');
      // the artifact names positions of the rule it was learned on: if the rule changed, it does not apply (never reorder a different rule)
      if (hash(slots.map(i => w.fields[i].value)) !== s.artifact.digest) throw new StaleSkillError(`rule ${s.artifact.rule} changed`);
      const picked = s.artifact.order.map(i => w.fields[i]);
      slots.forEach((slot, k) => { w.fields[slot] = picked[k]; });
    } else if (s.kind === 'lemma') {
      out.push(...readWires(s.artifact.text));
    }
  }
  return wiresText(out);
}
