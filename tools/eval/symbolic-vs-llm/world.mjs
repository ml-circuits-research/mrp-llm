import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StrategyRegistry} from '../../../memory/strategies.mjs';
import {BASE_NAME} from '../../../lib/chat-data/memories.mjs';
import {openWorld, openSession} from '../lib/session.mjs';
import {compileDeclarative} from '../../../sop/declarative.mjs';
import {parse as parseRuntime, canonical} from '../../../sop/parser.mjs';
import {parse, parseCondition} from '../../../sop/knowledge/lexical.mjs';
import {Theory, askMemory, termValue} from '../../../reasoning/slice/wire.mjs';
import {SliceRetrieval} from '../../../reasoning/slice/retrieval.mjs';
import {RepositorySource} from '../../../reasoning/slice/source.mjs';
import {alternatives, equalityDomains, bindDomains} from '../../../reasoning/slice/demand.mjs';
import {readForms} from '../../../reasoning/strategies/js-reference/forms.mjs';
import {Lowering, factWire} from '../../../reasoning/bridge/lower.mjs';
import {instant, interval} from '../../../lib/time.mjs';
import {routedAsk} from '../../../reasoning/router/index.mjs';

export const LIMITS = {maxLookups: 2000000, maxProbes: 5000000, maxFacts: 400000, maxGoals: 200000, retrievalMs: 120000};
export const BUDGET = {timeoutMs: 120000};
const value = (w, key) => w.fields.find(f => f.key === key)?.value.trim();
const tree = node => {
  if (!node) return null;
  if (node.kind === 'all' || node.kind === 'any') {
    const children = node.children.map(tree).filter(Boolean);
    return children.length ? {kind: node.kind, children} : null;
  }
  return node.kind === 'atom' ? {p: node.p, a: node.terms.map(termValue), neg: node.neg === 'not'} : null;
};

/** The base memory of a benchmark world in its private chat data root, and the time its facts became known. */
export const WORLD_MEMORY = 'benchmark';
const KNOWN_AT = new Date('2020-01-01T00:00:00Z');

/**
 * A benchmark world as the chat sees a memory: a private chat data root with a base memory `benchmark` holding the case knowledge
 * (lib/chat-data/memories.mjs) and a chat session on it with its session store (tools/eval/lib/session.mjs, reads never reinforce), so
 * the chat turns of the step-by-step arms (run.mjs) read the same circuits (rules, defaults, integrity constraints) and facts as the
 * gold computation. `repo` is the session's repository with the bases `main` (the chat's) and `base` (a fork at the same head),
 * `session` a reader session of `base` for the gold, `chat` the chat session (`store`, `sessions`, `id`, `config`), `theory` and
 * `lexicon` those of the knowledge.
 */
export function createWorld(knowledge) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbolic-bench-'));
  try {
    const {sessions} = openWorld({root});
    sessions.memories.create({id: WORLD_MEMORY, name: 'symbolic-vs-llm benchmark world', now: KNOWN_AT});
    sessions.memories.store(WORLD_MEMORY, {name: 'benchmark', text: knowledge}, {approvedBy: 'symbolic-vs-llm', reason: 'benchmark world', now: KNOWN_AT});
    const chat = openSession({base: WORLD_MEMORY, id: 'benchmark', user: 'benchmark', root});
    const repo = chat.store.repo;
    // The world's own base name `base` (the contract of earlier callers: SessionStore.get(user, conversation, 'base')) is a fork of the
    // session's base `main` at the same head: the same facts, no second ingestion.
    repo.fork(BASE_NAME, 'base');
    return {repo, session: repo.session('base', 'benchmark', 'dev'), theory: new Theory([{name: 'benchmark', text: knowledge}]),
      lexicon: chat.lexicon, chat, dispose: () => fs.rmSync(root, {recursive: true, force: true})};
  } catch (error) { fs.rmSync(root, {recursive: true, force: true}); throw error; }
}

/** Use the product compiler and exact identity resolution; never guess a relation or identity. */
export function linkCircuit(sop, question, lexicon, admitted = null) {
  const effectiveLexicon = admitted?.lexicon ?? lexicon;
  const plan = compileDeclarative(admitted?.modelSop ?? sop, {inputText: question, lexicon: effectiveLexicon, schema: effectiveLexicon.predicates, now: Date.parse('2026-10-01T00:00:00Z')});
  if (plan.issues?.length || plan.unclear || plan.notComputable?.length) return {plan, query: null};
  const program = parseRuntime(plan.executionSop);
  const bound = new Map();
  for (const w of program.wires.filter(w => w.type === 'resolve')) {
    const one = key => w.fields[key]?.[0];
    const result = effectiveLexicon.resolve(JSON.parse(one('text')), {language: one('language'), kind: one('kind'), type: one('type')});
    if (result.status !== 'bound') return {plan, query: null, issue: result};
    bound.set(w.id, result.id);
  }
  const queries = program.wires.filter(w => ['query', 'constraint'].includes(w.type));
  if (queries.length !== 1) return {plan, query: null, issue: {status: 'unsupported_circuit_composition'}};
  let query = canonical({wires: queries});
  query = query.replace(/\$([A-Za-z][A-Za-z0-9_]*)\b/g, (token, id) => bound.has(id) ? JSON.stringify(bound.get(id)) : token);
  if (/\$\w+/.test(query)) return {plan, query: null, issue: {status: 'unresolved_dependency'}};
  const facts = program.wires.filter(w => w.type === 'fact');
  const context = canonical({wires: facts}).replace(/\$([A-Za-z][A-Za-z0-9_]*)\b/g, (token, id) => bound.has(id) ? JSON.stringify(bound.get(id)) : token);
  if (/\$\w+/.test(context)) return {plan, query: null, issue: {status: 'unresolved_evidence_dependency'}};
  return {plan, query, context};
}

export function withDefinitions(world, admitted, context = '') {
  if (!admitted?.definitionSop && !context) return world;
  const original = world.theory;
  const theory = Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
    recs: [...original.recs], byHead: new Map([...original.byHead].map(([p, recs]) => [p, [...recs]])),
    byId: new Map(original.byId), predicates: new Map(original.predicates), closed: new Set(original.closed), carry: [...original.carry]
  });
  const definitionWires = parse(admitted?.definitionSop ?? '').wires;
  for (const wire of definitionWires) theory.add(wire);
  const contextWires = parse(context).wires.map(wire => {
    const source = value(wire, 'source');
    return {...wire, fields: [...wire.fields, {key: 'status', value: source === 'assumption' ? 'supposed' : 'observed', line: 0, block: []}]};
  });
  theory.carry.push(...contextWires);
  return {...world, theory, definitionWires: [...definitionWires, ...contextWires], lexicon: admitted?.lexicon ?? world.lexicon};
}

export function execute(world, query, {reasoning = 'auto', verify = 'auto', limits = LIMITS, budget = BUDGET, metrics = null} = {}) {
  const registry = new StrategyRegistry();
  const timed = {retrieve(name, request) {
    const start = performance.now();
    try { return registry.retrieve(name, request); }
    finally { if (metrics) metrics.retrieval_ms = (metrics.retrieval_ms ?? 0) + performance.now() - start; }
  }};
  return askMemory({...world, query, registry: timed, strategy: 'hybrid', reasoning, verify, limits, budget});
}

/** Reconstruct the exact final gold slice with the public retrieval classes and its recorded widening count.
 * Fail closed if the product's slice contract changes. No full-world evidence is substituted. */
export function goldSlice(world, query, packet, limits = LIMITS) {
  limits = {maxShards: 256, maxGoals: 256, maxRules: 1024, ...limits};
  const qw = parse(query).wires.find(w => w.type === 'query');
  const mode = qw ? value(qw, 'mode') ?? 'select' : 'select';
  const sliced = qw && ['select', 'exists', 'count', 'explain', 'every'].includes(mode);
  let conjunctions, closure;
  if (sliced) {
    const trees = qw.fields.filter(f => ['where', 'scope'].includes(f.key)).map(f => tree(parseCondition(f, []))).filter(Boolean);
    const atoms = trees.flatMap(function flat(t) { return t.children ? t.children.flatMap(flat) : [t]; });
    conjunctions = bindDomains(alternatives(trees) ?? atoms.map(a => [a]), equalityDomains(qw.fields.some(f => f.key === 'compare') ? readForms(qw).compares : []));
    closure = world.theory.closure(atoms, {maxRules: limits.maxRules ?? 1024});
  } else {
    conjunctions = [...world.theory.predicates].map(([p, w]) => [{p, a: Array.from({length: (value(w, 'args') ?? '').split(/\s+/).filter(Boolean).length || w.fields.filter(f => f.key === 'role').length}, (_, i) => '?v' + i), neg: false}]).filter(c => c[0].a.length > 0 && c[0].a.length <= 4);
    closure = {recs: world.theory.recs, predicates: new Set(world.theory.predicates.keys()), complete: true};
  }
  const window = {asof: Infinity};
  if (qw && value(qw, 'at')) window.at = instant(value(qw, 'at'));
  if (qw && (value(qw, 'during') || value(qw, 'overlaps'))) window.during = interval(value(qw, 'during') ?? value(qw, 'overlaps'));
  if (qw && value(qw, 'asof')) window.asof = instant(value(qw, 'asof'));
  const source = new RepositorySource({...world, registry: new StrategyRegistry(), strategy: 'hybrid', query: window, limits});
  const retrieval = new SliceRetrieval({source, conjunctions, rules: closure.recs.map(r => world.theory.asRule(r)), rulesComplete: closure.complete, limits, strategy: 'hybrid'});
  retrieval.expand();
  for (let step = 1; step < (packet.retrieval?.steps ?? 1); step++) if (!retrieval.widen()) throw new Error('gold slice widening differs from product');
  const result = retrieval.result({query: {mode}});
  if (result.facts.length !== packet.retrieval?.facts || result.rules.length !== packet.retrieval?.rules) throw new Error('gold slice membership differs from product');
  const declared = new Set([...closure.predicates, ...conjunctions.flat().map(a => a.p)]);
  const lowering = Object.assign(new Lowering(), {predicate: p => p});
  const wires = [...closure.recs.map(r => r.wire), ...[...declared].map(p => world.theory.predicates.get(p)).filter(Boolean), ...world.theory.carry,
    ...result.facts.map(f => factWire(lowering, f.id, f, f.kind === 'assumed' ? 'supposed' : 'observed'))];
  return {facts: result.facts, wires: [...new Map(wires.map(w => [w.id, w])).values()], retrieval: result.slice};
}

export const oracleOverSlice = (slice, query, budget = BUDGET) => routedAsk({handle: {kind: 'js-reference-handle', knowledge: '', wires: slice.wires}, query, requested: 'js-reference', verify: 'never', budget});
