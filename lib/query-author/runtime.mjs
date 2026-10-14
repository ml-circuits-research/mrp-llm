import fs from 'node:fs';
import path from 'node:path';
import {Runtime} from '../../sop/runtime.mjs';
import {parse, canonical, one, words} from '../../sop/parser.mjs';
import {TheoryCache, askMemory, termValue} from '../../reasoning/slice/index.mjs';
import {parseCondition, leaves} from '../../sop/knowledge/lexical.mjs';
import {Sessions} from '../chat-data/sessions.mjs';
import {Lowering, ruleWire, factWire} from '../../reasoning/bridge/lower.mjs';
import {outputSpecs, selectOutput} from '../../sop/outputs.mjs';
import {lowerFact} from '../../sop/lower.mjs';
import {conversationSymbol} from '../../sop/declarative.mjs';
import {predicateCircuits} from './session.mjs';
import {parse as parseKnowledge, validateProgram} from '../../sop/knowledge/index.mjs';
import {atomKey} from '../types.mjs';
import {conditionAtoms} from '../conditions.mjs';

const theories = new TheoryCache();

/**
 * The text of a rule or default the answer used (DS006 "Result packet", `rules_used`): its conditions, exceptions and conclusion as
 * typed atoms, a condition that is not a plain atom (a comparison, a computation, a group) as its SOP text. Null for any other wire.
 */
function ruleUsed(theory, id, origin) {
  const w = theory.byId.get(id), rec = theory.recs.find(r => r.id === id);
  if (!w || !rec || !['rule', 'default'].includes(w.type)) return null;
  const condition = f => {
    const parts = f.block?.length ? [] : leaves(parseCondition(f, []));
    return parts.length === 1 && parts[0].kind === 'atom' ? {atom: {p: parts[0].p, a: parts[0].terms.map(termValue), neg: parts[0].neg === 'not'}} : {text: [f.value, ...(f.block ?? []).map(b => b.text)].join(' ')};
  };
  return {id, kind: w.type, origin, conditions: w.fields.filter(f => f.key === 'when').map(condition), ...(w.type === 'default' ? {exceptions: w.fields.filter(f => f.key === 'except').map(condition)} : {}), conclusion: rec.head};
}

const wireText = w => `@${w.id} ${w.type}\n` + w.fields.map(f => `  ${f.key} ${f.value}\n` + (f.block ?? []).map(b => `    ${b.text}\n`).join('')).join('');
const flatten = xs => xs.flatMap(x => Array.isArray(x) ? flatten(x) : [x]);

/** Read only accepted layers; draft folders are deliberately absent. */
export function memoryCircuits(agent) {
  const folder = agent.repo?.root ? path.dirname(agent.repo.root) : null;
  if (folder && fs.existsSync(path.join(folder, 'session.json'))) {
    return ['base_circuits', 'circuits'].flatMap(dir => Sessions.prototype.readCircuits(path.join(folder, dir)));
  }
  const lowering = Object.assign(new Lowering(), {predicate: p => p});
  const rules = agent.circuitRules?.({asof: Infinity}) ?? [];
  const library = agent.repo && agent.session ? agent.repo.library(agent.session, {asof: Infinity}).filter(x => x.wireType === 'rule').map(x => ({name: x.id, text: x.sop})) : [];
  return [...predicateCircuits(agent.lexicon), ...library, ...rules.map(r => ({name: r.id, text: wireText(ruleWire(lowering, r))}))];
}

/** The existing declarative compiler and scheduler, with solve delegated to askMemory. */
export class AuthorRuntime extends Runtime {
  constructor({circuits, definitions = '', ...options}) {
    super(options);
    this.theory = theories.get([...circuits, ...(definitions ? [{name: 'coding-agent.sop', text: definitions}] : [])]);
    Object.assign(this, {baseCircuits: circuits, definitionText: definitions});
    const definitionWires = parseKnowledge(definitions).wires;
    this.definitionIds = new Set(definitionWires.map(w => w.id));
    // The session definitions by id (an `if` or a `candidate` may name a session rule) and the capability to run candidates (Q-LANG-10).
    this.sessionDefinitions = new Map(definitionWires.map(w => [w.id, w.type]));
    this.hypotheticalRuns = true;
    this.predicateCircuit = [...this.theory.byId.values()].filter(w => w.type === 'predicate').map(wireText).join('\n');
    this.handlers.authorAsk = ({wire, values}) => this.ask(wire, values);
    this.handlers.authorSupposition = ({wire, values}) => ({...lowerFact(wire, values, this.schema), id: wire.id, kind: 'turn_assumption', authorOrigin: this.modelAssumptionIds?.has(wire.id) ? 'coding_agent' : 'conversation'});
    this.handlers.authorBinding = ({wire, values}) => {
      const picked = selectOutput(values[one(wire, 'result').slice(1)], {variable: one(wire, 'variable'), mode: one(wire, 'mode')});
      if (picked.status !== 'bound') throw Object.assign(new Error('Which answer should the next question use?'), {clarification: picked});
      return picked.value;
    };
  }

  async run(source, options = {}) {
    if (options.origin === 'model') {
      this.modelAssumptionIds = new Set(parse(source).wires.filter(w => w.type === 'assumed').map(w => w.id));
      return super.run(source, options);
    }
    const program = parse(source);
    const original = new Map(program.wires.map(w => [w.id, w]));
    const consumed = new Set();
    const pending = program.wires.filter(w => ['solve', 'reason'].includes(w.type)).flatMap(w => (w.fields.assume ?? []).flatMap(words));
    while (pending.length) {
      const id = pending.pop().replace(/^[$~]/, '');
      if (consumed.has(id)) continue;
      consumed.add(id);
      const definition = original.get(id);
      if (definition?.type === 'pack') pending.push(...(definition.fields.items ?? []).flatMap(words));
    }
    for (const w of program.wires) {
      if (w.type === 'fact' && one(w, 'source') === 'assumption' && !consumed.has(w.id)) throw new Error('assumption_fact_unconsumed: a source assumption fact must be consumed by an assume reference');
    }
    const wires = [];
    for (const w of program.wires) {
      if (w.type === 'fact' && one(w, 'source') === 'assumption') { wires.push({...w, type: 'authorSupposition'}); continue; }
      if (w.type !== 'solve' || !w.fields.query) { wires.push(w); continue; }
      const fields = {...w.fields};
      delete fields.output;
      // The raw generated query keeps every word form; resolve only value references at execution time.
      this.queryTemplates ??= new Map();
      this.queryTemplates.set(w.id, original.get(one(w, 'query').slice(1)));
      wires.push({...w, type: 'authorAsk', fields});
      for (const s of outputSpecs(w)) wires.push({id: s.name, type: 'authorBinding', fields: {result: ['$' + w.id], variable: [s.variable], mode: [s.mode]}, line: 0});
    }
    try { return await super.run(canonical({wires}), options); }
    catch (error) {
      if (!error.clarification) throw error;
      return {values: {}, result: {kind: 'cnl', language: 'en', text: error.message, packet: {status: 'clarify', complete: false, reason: 'query_output_cardinality'}}, trace: [], outputs: {}, blocked: {}, generated: []};
    }
  }

  ask(wire, values) {
    const q = values[one(wire, 'query').slice(1)];
    const lowering = Object.assign(new Lowering(), {predicate: p => p});
    const source = this.queryTemplates.get(wire.id);
    const subst = text => String(text).replace(/"(?:\\.|[^"\\])*"|\$[A-Za-z][A-Za-z0-9_]*/g, t => t.startsWith('$') ? lowering.term(values[t.slice(1)]) : t);
    const fields = Object.fromEntries(Object.entries(source.fields).map(([k, vs]) => [k, vs.map(subst)]));
    fields.mode = [q.mode];
    const closedNegations = new Set();
    fields.where = (fields.where ?? []).map(text => text.split('\n').map(line => {
      const match = line.match(/^(\s*)not ([A-Za-z][A-Za-z0-9_]*) (.+)$/);
      if (!match || !this.theory.closed.has(match[2])) return line;
      closedNegations.add(match[2]);
      const [, indent, predicate, terms] = match;
      return `${indent}any\n${indent}  not ${predicate} ${terms}\n${indent}  absent ${predicate} ${terms}\n${indent}end`;
    }).join('\n'));
    // Generated query-only clause links are already represented by the solve's scoped assumptions.
    for (const k of ['if', 'unless', 'because', 'so', 'although', 'so_that', 'before', 'after', 'when', 'while']) delete fields[k];
    // An abduction explains its observation: a statement of the observation itself is the thing explained, never a premise
    // ("true because observed" is not an explanation; reasoning/abduction.mjs does the same on the typed path).
    const observed = q.mode === 'abduce' ? new Set(conditionAtoms(q.where).filter(a => a.a.every(v => !(typeof v === 'string' && v.startsWith('?')))).map(atomKey)) : new Set();
    const local = flatten((wire.fields.data ?? []).map(ref => values[ref.slice(1)])).filter(f => !(f?.atom && observed.has(atomKey(f.atom))));
    if (local.some(f => f.kind === 'turn_assumption' || f.source === 'assumption')) throw new Error('assumption_fact_not_evidence: a source assumption fact may only be consumed through assume');
    const assumptions = flatten((wire.fields.assume ?? []).map(ref => values[ref.slice(1)]));
    if (assumptions.length) {
      const check = validateProgram([{name: 'memory-vocabulary.sop', text: this.predicateCircuit}, {name: 'turn-assumptions.sop', role: 'query', text: assumptions.map((f, i) => wireText(factWire(lowering, 'assume_' + i, f, 'supposed'))).join('\n')}], {authoring: true});
      const problem = check.problems.find(p => p.severity !== 'warning');
      if (problem) throw new Error(`${problem.code}: ${problem.message}`);
    }
    // A session definition that names an entity the same turn's statements introduced ("Group A" in a rule of a problem) means that
    // conversation entity: its quoted constant becomes the entity's symbol, as in the statements and the question.
    const locals = new Set(local.flatMap(f => (f.atom?.a ?? []).filter(t => typeof t === 'string' && t.startsWith('local_'))));
    if (locals.size && this.definitionText) {
      const text = this.definitionText.replace(/"(?:\\.|[^"\\])*"/g, quoted => { const symbol = conversationSymbol(JSON.parse(quoted)); return locals.has(symbol) ? symbol : quoted; });
      if (text !== this.definitionText) this.theory = theories.get([...this.baseCircuits, {name: 'coding-agent.sop', text}]);
    }
    const localText = local.map((f, i) => wireText(factWire(lowering, 'turn_local_' + i, f))).join('\n');
    const conflicts = [];
    const kept = [];
    // Hypothetical runs (Q-LANG-10, sop/declarative.mjs `hypotheticalRuns`): the query's candidates and the session rules its `if` supposes.
    // A candidate statement is not defeated here: the oracle classifies it (`inconsistent` when what is known contradicts it).
    const hypothetical = this.hypothetical?.get(source.id) ?? null;
    const candidateStatements = new Set(hypothetical?.candidates ?? []);
    for (const [i, f] of assumptions.entries()) {
      if (candidateStatements.has(f.id)) { kept.push({id: 'assume_' + i, f}); continue; }
      const contrary = {...f.atom, neg: !f.atom.neg};
      const time = ['at', 'during', 'asof'].flatMap(k => (fields[k] ?? []).map(v => `  ${k} ${v}\n`)).join('');
      const test = askMemory({theory: this.theory, repo: this.repo, session: this.session, lexicon: this.lexicon, query: `@conflict query\n  mode exists\n  where ${lowering.atom(contrary)}\n` + time + localText, limits: this.policy, reasoning: 'auto', budget: this.policy});
      if (['supported', 'both'].includes(test.status)) conflicts.push({id: 'assume_' + i, circuit: f.id, origin: f.authorOrigin, status: 'defeated', reason: 'memory_wins', atom: f.atom});
      else kept.push({id: 'assume_' + i, f});
    }
    const facts = kept.map(({id, f}) => wireText(factWire(lowering, id, f, 'supposed'))).join('\n');
    // The oracle names a candidate statement by its supposition id; the packet names it by the statement the model wrote.
    const assumeOf = new Map(kept.filter(({f}) => candidateStatements.has(f.id)).map(({id, f}) => [f.id, id]));
    const statementOf = new Map([...assumeOf].map(([statement, id]) => [id, statement]));
    if (hypothetical) {
      for (const c of hypothetical.candidates) if (!this.sessionDefinitions?.has(c) && !assumeOf.has(c)) throw new Error(`candidate_target: candidate $${c} names a statement that did not reach the question`);
      if (hypothetical.candidates.length) fields.candidate = hypothetical.candidates.map(c => '$' + (assumeOf.get(c) ?? c));
      if (hypothetical.rules.length) fields.if = hypothetical.rules.map(r => '$' + r);
    }
    const query = canonical({wires: [{...source, fields}]}) + '\n' + localText + '\n' + facts;
    const retrieved = new Map();
    const registry = {retrieve: (strategy, request) => {
      const result = this.strategies.retrieve(strategy, request);
      for (const row of result.rows) retrieved.set(row.id, row);
      return result;
    }};
    // `order random` draws its sample with the turn's seed: an explicit policy `sampleSeed`, otherwise the turn time.
    const raw = askMemory({theory: this.theory, repo: this.repo, session: this.session, lexicon: this.lexicon, query, registry, limits: this.policy, strategy: this.policy.retrievalStrategy, budget: this.policy, seed: this.policy.sampleSeed ?? this.now, reasoning: this.policy.reasoningStrategy === 'reference' ? 'auto' : this.policy.reasoningStrategy ?? 'auto'});
    const used = [...(raw.used ?? [])];
    if (raw.status === 'supported' && !used.length) {
      for (const id of closedNegations) if (this.definitionIds.has(id)) used.push({id});
    }
    const assumptionOrigins = new Map(kept.map(({id, f}) => [id, f.authorOrigin]));
    const origins = used.map(item => ({id: item.id, origin: this.definitionIds.has(item.id) ? 'coding_agent' : assumptionOrigins.get(item.id) ?? (item.id.startsWith('turn_local_') ? 'conversation' : 'memory'), kind: item.id.startsWith('assume_') ? 'assumption' : this.definitionIds.has(item.id) ? 'definition' : item.id.startsWith('turn_local_') ? 'statement' : 'memory'}));
    const originsById = new Map(origins.map(o => [o.id, o.origin]));
    const localById = new Map([...local.map((f, i) => ['turn_local_' + i, {...f, id: 'turn_local_' + i, kind: 'observed'}]), ...kept.map(({id, f}) => [id, {...f, id, kind: 'assumed'}])]);
    const proof = used.flatMap(item => {
      const fact = localById.get(item.id) ?? retrieved.get(item.id);
      return fact ? [{...fact, origin: originsById.get(item.id), ...(item.id.startsWith('turn_local_') ? {evidence: {...fact.evidence, local: true}} : {})}] : [];
    });
    const packet = {...raw, used, query: q, backend: raw.strategy === 'js-reference' ? 'js' : [raw.route?.chosen, raw.route?.backend, raw.route?.requested].includes('prolog-tabling') ? 'prolog' : raw.route?.backend, kind: q.mode === 'count' ? 'count' : q.mode === 'every' ? 'every' : 'query', answers: (raw.rows ?? []).map(binding => ({binding: Object.fromEntries(Object.entries(binding).map(([name, value]) => [name.startsWith('?') ? name : '?' + name, value]))})), proof, origins, session_conflicts: conflicts, defeatedAssumptions: conflicts.map(c => c.id), hypothetical: Boolean(raw.conditional?.length), ...(raw.bound === 'at_least' ? {at_least: raw.count} : {})};
    if (!packet.answers.length && q.mode === 'exists' && ['supported', 'both'].includes(packet.status)) packet.answers = [{binding: {}}];
    // An explanation names the rules it used with their text, not only the facts (the renderer writes them, sop/answer-text.mjs).
    if (q.mode === 'explain') packet.rules_used = used.map(item => ruleUsed(this.theory, item.id, originsById.get(item.id))).filter(Boolean);
    // The candidates of mode effect and abduce by the ids the model wrote, each with what the renderer says about it: a statement's atom,
    // a rule's conditions and conclusion (DS006 "Result packet", `effects`, `necessary`).
    if (hypothetical?.candidates.length) {
      const back = id => statementOf.get(id) ?? id;
      const describe = id => {
        const f = kept.find(k => k.id === id)?.f;
        return f ? {id: back(id), kind: 'fact', atom: f.atom} : {id, kind: 'rule', rule: ruleUsed(this.theory, id, 'coding_agent')};
      };
      if (raw.effects) packet.effects = raw.effects.map(e => ({...e, candidate: back(e.candidate), described: describe(e.candidate)}));
      if (raw.explanations) packet.explanations = raw.explanations.map(e => ({...e, hypotheses: e.hypotheses.map(back), candidates: e.hypotheses.map(describe)}));
      if (raw.inconsistent) packet.inconsistent = raw.inconsistent.map(e => ({...e, hypotheses: e.hypotheses.map(back), candidates: e.hypotheses.map(describe)}));
      if (raw.necessary) packet.necessary = raw.necessary.map(back);
      packet.candidates = hypothetical.candidates.map(c => describe(assumeOf.get(c) ?? c));
    }
    if (packet.route) packet.route = {...packet.route, backend: packet.backend};
    return packet;
  }
}
