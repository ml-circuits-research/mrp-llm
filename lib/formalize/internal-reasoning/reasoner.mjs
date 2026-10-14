/**
 * The control of InternalReasoningStepByStep (DS022 "InternalReasoningStepByStep"): the protocol memory
 * (config/knowledge/formalizer-protocol-v1) is prepared once per version by the JS oracle (reasoning/strategies/js-reference); every
 * decision adds the facts of the request (observations and established slots) as the turn theory and asks the oracle
 *   - `mode plan` to the goal `formalized`: the first action of the cheapest plan is the next question (or the system's own
 *     `assemble` step); a plan of no step means the goal holds; `no_plan` means no question can complete the circuit;
 *   - one closure for everything the code reads (open slots, violations, askable questions, the values the defaults settled), with
 *     the derivation of the chosen question for the trace (`mode explain` over the same closure).
 * The greedy controller (an ablation, and the fallback when the plan budget is exhausted) asks the askable question of the lowest
 * `priority` instead of planning.
 */
import {createHash} from 'node:crypto';
import {prepare, ask, update} from '../../../reasoning/strategies/js-reference/index.mjs';
import {tokens} from '../../../reasoning/strategies/js-reference/wires.mjs';
import {proofOf} from '../../../reasoning/strategies/js-reference/support.mjs';
import {protocolCircuits} from '../protocol-data.mjs';
import {seedCircuits} from '../../knowledge-seeds.mjs';
import {NS, stripNs} from './state.mjs';

export const PROTOCOL_ID = 'formalizer-protocol-v1';
const PLAN_KEYS = {max_depth: 'maxDepth', max_nodes: 'maxNodes', timeout_ms: 'timeoutMs'};
const cache = new Map();

const term = t => t.startsWith('"') ? JSON.parse(t) : /^-?\d+$/.test(t) ? Number(t) : t;

/**
 * The protocol memory: its own circuits (core-min, which it imports for the lexicon, holds no protocol wires), prepared once per
 * content digest. `circuits` overrides the shipped files (tests, authoring). Returns the handle and an index of the static data.
 */
export function loadProtocol({id = PROTOCOL_ID, circuits = null} = {}) {
  // The protocol layer and the learned-rules layer (lib/formalize/protocol-data.mjs), unless `circuits` overrides them.
  const own = circuits ?? (id === PROTOCOL_ID ? protocolCircuits() : seedCircuits(id)).map(c => ({name: c.file, text: c.text}));
  const text = own.map(c => c.text).join('\n');
  const version = createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (cache.has(version)) return cache.get(version);
  const handle = prepare(text);
  const data = new Map();
  for (const w of handle.wires) {
    if (w.type !== 'fact') continue;
    const [full, ...args] = tokens(w.fields.find(f => f.key === 'holds').value.trim());
    const p = stripNs(full);
    if (!data.has(p)) data.set(p, []);
    data.get(p).push(args.map(term));
  }
  const rows = p => data.get(p) ?? [];
  const one = (p, key) => rows(p).find(r => r[0] === key)?.[1] ?? null;
  const questions = new Map();
  for (const [q, text] of rows('question_text')) {
    const choices = rows('choice').filter(r => r[0] === q).map(([, n, value]) => ({n, value, text: rows('choice_text').find(r => r[0] === q && r[1] === n)?.[2] ?? null,
      asserts: rows('choice_asserts').find(r => r[0] === q && r[1] === n)?.[2] ?? null})).sort((a, b) => a.n - b.n);
    questions.set(q, {id: q, text, format: one('answer_format', q), establishes: one('establishes', q), asserts: one('asserts', q), priority: one('priority', q) ?? 999,
      from: one('choices_from', q), zero: one('zero_choice', q), auto: rows('auto_single').some(r => r[0] === q), autoFirst: rows('auto_first_asked').some(r => r[0] === q),
      followUp: one('follow_up', q), choices});
  }
  const actions = handle.wires.filter(w => w.type === 'action').map(w => stripNs(w.id));
  const effects = new Map(handle.wires.filter(w => w.type === 'action').map(w => [stripNs(w.id), {
    adds: w.fields.filter(f => f.key === 'adds').map(f => tokens(f.value.trim())).map(([p, ...a]) => [stripNs(p), ...a]).filter(([p]) => p !== 'answered'),
    removes: w.fields.filter(f => f.key === 'removes').map(f => tokens(f.value.trim())).map(([p, ...a]) => [stripNs(p), ...a])}]));
  const defaults = handle.wires.filter(w => w.type === 'default').map(w => { const [p, ...head] = tokens(w.fields.find(f => f.key === 'then').value.trim()); return {id: w.id, name: stripNs(w.id), head: [stripNs(p), ...head]}; });
  const plan = Object.fromEntries(rows('plan_budget').map(([k, v]) => [PLAN_KEYS[k] ?? k, v]));
  const budget = Object.fromEntries(rows('question_budget'));
  const protocol = {id, version, text, circuits: own, handle, data, rows, questions, actions, effects, defaults, plan, budget,
    heuristics: new Set(rows('heuristic').map(r => r[0])), notes: new Map(rows('violation_note')), problemSlots: new Map(rows('problem_slot')),
    predicates: handle.wires.filter(w => w.type === 'predicate').map(w => ({id: w.id, name: stripNs(w.id), arity: arityOf(w)}))};
  protocol.view = viewQuery(protocol);
  cache.set(version, protocol);
  return protocol;
}

function arityOf(w) {
  const args = w.fields.find(f => f.key === 'args')?.value.trim() ?? '';
  return !args || args === 'none' ? 0 : args.split(/\s+/).length;
}

/** One `exists` query over every predicate of the protocol: its closure is the view the code reads with `rows`. */
function viewQuery(protocol) {
  const vars = ['?a', '?b', '?c', '?d'];
  const leaves = protocol.predicates.filter(p => p.arity <= 4).map(p => `    ${[p.id, ...vars.slice(0, p.arity)].join(' ')}`);
  leaves.push('    violation ?a ?b');
  return `@view query\n  mode exists\n  where any\n${leaves.join('\n')}\n  end\n`;
}

/** The closure of the turn theory: `rows(p, ...prefix)` reads derived and stored atoms; `explain(atom)` gives its derivation. */
export function closure(protocol, facts) {
  const started = performance.now();
  const turn = update(protocol.handle, {add: facts.text()});
  const packet = ask({handle: turn, query: protocol.view, conditional: false, detail: true});
  const part = packet.detail?.parts?.[0];
  if (!part) throw new Error(`the protocol could not be evaluated: ${packet.status} ${packet.reason ?? ''}`);
  const read = new Map();
  const select = (p, n) => {
    const key = `${p}/${n}`;
    if (!read.has(key)) {
      const vars = ['?a', '?b', '?c', '?d'].slice(0, n);
      const out = part.reread([{key: 'where', value: [p, ...vars].join(' '), block: []}], 'select', vars);
      read.set(key, out.rows.map(r => ({args: vars.map(v => String(r.row[v.slice(1)])), prem: r.prem})));
    }
    return read.get(key);
  };
  const arity = new Map(protocol.predicates.map(p => [p.name, p.arity]));
  const full = p => p === 'violation' ? p : NS + p;
  const view = {
    turn, ms: 0,
    rows(p, ...prefix) {
      const n = p === 'violation' ? 2 : arity.get(p) ?? 0;
      if (n === 0) return part.reread([{key: 'where', value: full(p), block: []}], 'exists', []).rows.length ? [[]] : [];
      const rows = select(full(p), n).map(r => p === 'violation' ? [stripNs(r.args[0]), ...r.args.slice(1)] : r.args);
      return rows.filter(r => prefix.every((x, i) => r[i] === String(x)));
    },
    has(p, ...args) { return this.rows(p, ...args).length > 0; },
    /** The conclusions a default of the protocol fired (its head arguments). */
    fired(id, n) {
      const vars = ['?a', '?b', '?c', '?d'].slice(0, n);
      try { return part.reread([{key: 'where', value: [`x_${id}_fired`, ...vars].join(' '), block: []}], 'select', vars).rows.map(r => vars.map(v => String(r.row[v.slice(1)]))); } catch { return []; }
    },
    /** The derivation of a ground atom as nested lines: the rules and defaults applied and the stored facts they rest on. */
    explain(p, ...args) {
      const n = arity.get(p) ?? args.length;
      const row = n ? select(full(p), n).find(r => args.every((x, i) => r.args[i] === String(x))) : null;
      return row ? derivation(proofOf(row.prem)) : null;
    },
  };
  view.ms = performance.now() - started;
  return view;
}

/** A proof DAG as short lines "atom ← rule (premises)", depth-first from the root, stored facts as leaves. */
function derivation(proof) {
  const byId = new Map(proof.nodes.map(n => [n.id, n]));
  const lines = [];
  const seen = new Set();
  const visit = (id, depth) => {
    const n = byId.get(id);
    if (!n || seen.has(id) || depth > 6) return;
    seen.add(id);
    const how = n.kind === 'fact' ? 'stated' : `${n.kind} ${stripNs(String(n.source?.id ?? '').replace(/^x_(.+?)_(?:conclude|fire|applies)$/, '$1'))}`;
    const plain = t => String(t).split(' ').map(stripNs).join(' ');
    lines.push(`${'  '.repeat(depth)}${plain(n.atom)} ← ${how}${n.absent?.length ? ` (absent: ${n.absent.map(plain).join(', ')})` : ''}`);
    for (const p of n.premises) visit(p, depth + 1);
  };
  for (const r of proof.roots) visit(r, 0);
  return lines;
}

/**
 * One decision. `control` is 'plan' (the cheapest plan's first action) or 'greedy' (the askable question of lowest priority).
 * Returns {kind: 'act'|'done'|'stuck', action, arg, control, plan, cost, open, violations, askable, why, view, ms: {closure, plan}}.
 */
export function decide(protocol, facts, {control = 'plan'} = {}) {
  const view = closure(protocol, facts);
  const open = view.rows('open_slot');
  const violations = view.rows('violation');
  const askable = view.rows('askable');
  const base = {open, violations, askable, view, ms: {closure: Math.round(view.ms * 10) / 10, plan: 0}};
  if (view.rows('formalized').length) return {...base, kind: 'done', control};
  const greedy = reason => {
    if (!askable.length) return {...base, kind: 'stuck', control: 'greedy', reason};
    const priority = q => protocol.questions.get(q)?.priority ?? 999;
    const [action, arg] = [...askable].sort((a, b) => priority(a[0]) - priority(b[0]))[0];
    return {...base, kind: 'act', action, arg, control: reason === 'greedy' ? 'greedy' : 'greedy_fallback', reason, why: view.explain('askable', action, arg)};
  };
  if (control === 'greedy') return greedy('greedy');
  const started = performance.now();
  const packet = ask({handle: view.turn, query: `@g query\n  mode plan\n  where ${NS}formalized\n`, conditional: false}, protocol.plan);
  base.ms.plan = Math.round((performance.now() - started) * 10) / 10;
  if (packet.status === 'plan_found') {
    const step = packet.plan.sequence[0];
    if (!step) return {...base, kind: 'done', control};
    const action = stripNs(step.action);
    return {...base, kind: 'act', action, arg: step.args[0] ?? 'none', control, plan: packet.plan.names.map((n, i) => `${stripNs(n)} ${packet.plan.sequence[i].args.join(' ')}`.trim()),
      cost: packet.plan.cost, expanded: packet.expanded, why: view.explain('askable', action, step.args[0] ?? 'none')};
  }
  if (packet.status === 'no_plan') return {...base, kind: 'stuck', control, reason: 'no_plan', expanded: packet.expanded};
  // The plan budget was exhausted (horizon, nodes or wall clock): the greedy choice decides this step.
  return greedy(`plan ${packet.status} (${packet.reason ?? ''})`);
}

/** Atoms the defaults of the protocol concluded that no answer stored (the questions the early exits avoided). */
export function defaultsFired(protocol, facts, view) {
  const out = [];
  for (const d of protocol.defaults) {
    const [p, ...head] = d.head;
    for (const args of view.fired(d.id, head.length)) if (!facts.has(p, ...args)) out.push({default: d.name, atom: [p, ...args].join(' ')});
  }
  // A head shared by several defaults is counted once.
  return [...new Map(out.map(o => [o.atom, o])).values()];
}
