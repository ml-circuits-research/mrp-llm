/**
 * InternalReasoningStepByStep (DS022 "InternalReasoningStepByStep", owner decision 2026-10-02): the questioning protocol of a small
 * local model lives as wires in a base memory (config/knowledge/formalizer-protocol-v1: questions as `action` wires with their texts
 * and choices as facts, slots as facts, slot rules, early exits as `default` wires, consistency as `integrity` wires, the goal
 * `formalized`), and reasoning decides the questioning. Every decision the JS oracle plans to the goal over the protocol plus the
 * request's facts (observations from structure and memory data, the slots established so far); the first action of the cheapest plan
 * is the next question, `no_plan` is an honest "the knowledge has no statement for this request". The model only answers short
 * numbered questions; code reads the answers structurally, asserts the slots, assembles the circuit with LocalLLMStepByStep's circuit
 * writer and validates it with the same validator as every author. Validator problems become facts for the next decision.
 *
 * The result has the shape of `authorQuery` (status validated | invalid | failed, sop, validation, unclear, usage, runs), plus `steps`
 * (the model calls), `trace` (the decisions) and `explanation` (the trace as English lines).
 */
import {validateQuery, unclearKind} from '../../query-author/validate.mjs';
import {splitCircuits} from '../../query-author/session.mjs';
import {createOracle, Unreadable} from '../../query-author/step-by-step/index.mjs';
import {observe, statementOf, entityRole, isNumberRole, classFit, rankStatements} from './state.mjs';
import {loadProtocol, decide, defaultsFired, PROTOCOL_ID} from './reasoner.mjs';
import {prefixOf} from './render.mjs';
import {HANDLERS, AFTER} from './handlers.mjs';
import {programOf, sopOf, paraphraseOf, flips, matchOf} from './program.mjs';
import {traceEntry, explainTrace} from './trace.mjs';
import {statementText, phraseOf} from '../../query-author/step-by-step/assemble.mjs';

export {loadProtocol, PROTOCOL_ID} from './reasoner.mjs';
export const MAX_DECISIONS = 60;
export const CONTROLS = Object.freeze(['plan', 'greedy']);

/** The stable prefix of the strategy's slot: the system message and the first-turn start, rendered from the protocol memory. */
export const internalReasoningPrefix = (protocol = loadProtocol()) => prefixOf(protocol);

/** The oracle of this strategy: LocalLLMStepByStep's growing conversation with the protocol's own system message. */
export const createReasoningOracle = ({chat, ladder = null, protocol = loadProtocol()}) => createOracle({chat, ladder, system: prefixOf(protocol).system});

const setFlag = (facts, flag, on) => on ? facts.add(flag) : facts.remove(f => f.p === flag);

/**
 * Role fit of the names that may fill the places of each used statement (observed_place, misfit), from the stored facts: the
 * instances, the statement a clause says, and every name the request may mean (a superset of the linked names: the protocol's rules
 * keep only the names of the query).
 */
function observeFit(ctx, facts) {
  const names = new Set([...facts.rows('linked').map(r => r[1]), ...facts.rows('clause_own_name').map(r => r[1])]);
  for (const [m] of facts.rows('single_candidate')) for (const [, n] of facts.rows('mention_candidate', m)) names.add(n);
  const statements = new Set(facts.rows('instance_of').map(r => r[1]));
  for (const [, st] of [...facts.rows('clause_pick'), ...facts.rows('clause_single_hit')]) statements.add(st);
  for (const st of statements) {
    const p = ctx.sym.statement.get(st);
    if (!p) continue;
    for (const n of names) {
      const key = `${n}|${st}`;
      if (ctx.fitDone.has(key)) continue;
      ctx.fitDone.add(key);
      const id = ctx.sym.name.get(n);
      for (const k of ctx.roleFit.observed(id, p)) facts.add('observed_place', n, st, p.roles[k].name);
      p.roles.forEach((r, k) => { if (entityRole(r) && (!ctx.roleFit(id, p, k) || !classFit(ctx.lexicon, id, r))) facts.add('misfit', n, st, r.name); });
    }
  }
}

/** The statement each clause says (a default or an answer), for the handlers and the assembly. */
function clauseInstances(ctx, facts, view) {
  for (const [c, i] of facts.rows('clause_instance')) {
    const st = view.rows('clause_pick', c)[0]?.[1];
    if (st && ctx.sym.instance.get(i)?.statement !== st) ctx.sym.instance.set(i, {query: c, statement: st});
  }
}

/**
 * Coverage (once, when the main query's places are first done): content words of the request that no chosen statement covers (and that
 * are not words of its names) and that name exactly one other statement of the memory, at most two, as `uncovered q st`.
 */
function observeCoverage(ctx, facts, view) {
  if (ctx.coverageDone || !view.rows('places_done', 'q').length) return false;
  ctx.coverageDone = true;
  const form = view.rows('query_kind', 'q')[0]?.[1];
  if (!['list', 'value', 'count', 'highest', 'lowest'].includes(form)) return false;
  const text = ctx.mainText ?? ctx.message;
  const chosen = new Set(view.rows('uses', 'q').map(r => statementOf(ctx, r[1])?.id).filter(Boolean));
  const nameWords = ctx.stems(ctx.spans.map(s => s.surface).join(' '));
  const covered = ctx.stems([...chosen].map(id => `${phraseOf(ctx.lexicon.predicates[id] ?? {id})} ${id}`).join(' '));
  const missing = [...ctx.stems(text)].filter(w => !covered.has(w) && !nameWords.has(w) && !/^\d+$/.test(w));
  let changed = false, n = 0;
  for (const word of missing) {
    if (n >= 2) break;
    const candidates = rankStatements(ctx, text).filter(p => !chosen.has(p.id) && ctx.stems(`${phraseOf(p)} ${p.id}`).has(word));
    if (candidates.length !== 1) continue;
    const st = ctx.sym.statementOf.get(candidates[0].id);
    if (ctx.payload.uncovered?.[st]) continue;
    (ctx.payload.uncovered ??= {})[st] = (new RegExp(`[\\p{L}-]*${word}[\\p{L}-]*`, 'iu').exec(text) ?? [word])[0];
    changed = facts.add('uncovered', 'q', st) || changed;
    n++;
  }
  return changed;
}

/** Statements of a query whose places are done but that share nothing (checked before the circuit is assembled). */
function observeLinks(ctx, facts, view) {
  let changed = false;
  for (const [qq] of view.rows('places_done')) {
    if (ctx.payload.connect?.[qq] || facts.has('answered', 'ask_connect', qq)) continue;
    const pairs = connectPairs(ctx, view, qq);
    if (pairs) { (ctx.payload.connect ??= {})[qq] = pairs; changed = facts.add('disconnected', qq) || changed; }
  }
  return changed;
}

/** Groups of matches linked by a shared unknown or name. */
function components(matches) {
  const keys = m => new Set(m.roles.map(r => JSON.stringify(r.value)));
  const groups = [];
  for (const m of matches) {
    const own = keys(m);
    const linked = groups.filter(g => g.some(x => [...keys(x)].some(k => own.has(k))));
    for (const g of linked) groups.splice(groups.indexOf(g), 1);
    groups.push([m, ...linked.flat()]);
  }
  return groups;
}

/** The plausible links between two groups of statements that share nothing (a shared unknown Y), or null. */
function connectPairs(ctx, view, qq) {
  const matches = view.rows('uses', qq).map(r => r[1]).filter(i => !ctx.payload.only?.[qq] || ctx.payload.only[qq].includes(i)).map(i => matchOf(ctx, view, i));
  const groups = components(matches);
  if (groups.length < 2) return null;
  const asked = v => ['?x', '?m'].includes(v);
  const main = groups.find(g => g.some(m => m.roles.some(r => asked(r.value.value)))) ?? groups[0];
  const other = groups.find(g => g !== main);
  const declared = (m, r) => ctx.lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name) ?? {};
  const places = g => g.flatMap(m => m.roles.filter(r => r.value.kind === 'var').map(r => ({m, r, number: isNumberRole(declared(m, r))})));
  const others = [...(ctx.payload.compares?.[qq] ?? []), qq === 'q' ? '?x' : ''];
  const uses = v => matches.reduce((n, m) => n + m.roles.filter(r => r.value.kind === 'var' && r.value.value === v).length, 0) + others.filter(t => new RegExp(`\\${v}\\b`).test(t)).length;
  const target = places(main).sort((a, b) => Number(asked(b.r.value.value)) - Number(asked(a.r.value.value)));
  const free = places(other).filter(p => /^\?a\d+$/.test(p.r.value.value) || (uses(p.r.value.value) === 1 && !asked(p.r.value.value)));
  const pairs = target.flatMap(t => free.filter(f => f.number === t.number).map(f => [t, f])).slice(0, 4);
  if (!pairs.length) return null;
  const show = p => {
    const predicate = ctx.lexicon.predicates[p.m.predicate];
    return statementText(predicate, predicate.roles.map(role => { const r = p.m.roles.find(x => x.name === role.name); return r === p.r ? 'Y' : r.value.kind === 'var' ? 'something' : String(r.value.value); }));
  };
  const placeOf = p => { const predicate = ctx.lexicon.predicates[p.m.predicate]; return predicate ? [predicate, predicate.roles.findIndex(x => x.name === p.r.name)] : null; };
  const kind = ([t, f]) => { const a = placeOf(t), b = placeOf(f); return a && b ? ctx.roleFit.samePlaceKind(a[0], a[1], b[0], b[1]) : null; };
  const symbol = v => `unknown_${v.slice(1)}`;
  const plausible = pairs.filter(pair => kind(pair) !== false).map(([t, f]) => ({from: symbol(f.r.value.value), to: symbol(t.r.value.value), text: `"${show(t)}" and "${show(f)}"`, number: t.number, sure: kind([t, f]) === true}));
  if (!plausible.length) return null;
  const sure = plausible.filter(p => p.sure);
  const single = plausible.length === 1 && !plausible[0].number ? plausible[0] : sure.length === 1 && !sure[0].number ? sure[0] : null;
  return {plausible, single};
}

const describe = out => !out ? null : out.empty ? 'nothing to ask: no option' : out.avoided ? `taken without asking (${out.avoided})` : out.picked ? `picked ${JSON.stringify(out.picked)}` : null;

/**
 * Formalize one message. `oracle`: createReasoningOracle({chat}) (or LocalLLMStepByStep's createOracle with the protocol's system
 * message); `control`: 'plan' (default) or 'greedy' (the ablation). The other arguments are those of `authorQuery`.
 */
export async function internalReasoningQuery({message, lexicon, circuits = [], repo = null, session = null, derived = null, oracle: base, validate = validateQuery,
  control = 'plan', protocol = loadProtocol(), model = null, onProgress = () => {}}) {
  if (!CONTROLS.includes(control)) throw new TypeError(`unknown control ${JSON.stringify(control)}; use one of ${CONTROLS.join(', ')}`);
  const started = Date.now();
  const prefix = prefixOf(protocol);
  const {ctx, facts} = observe({message, lexicon, circuits, repo, session, derived, budget: protocol.budget});
  ctx.fitDone = new Set();
  ctx.avoided = [];
  const total = protocol.budget.total ?? 16, reserve = protocol.budget.reserve ?? 3;
  const retrieval = {mode: 'id', predicates: ctx.statements.map(p => p.id), neighbourhood: ctx.neighbourhood,
    entities: ctx.mentions.map(m => ({surface: m.surface, candidates: m.candidates.map(c => c.id), strong: /\s/.test(m.surface) || /^\p{Lu}/u.test(m.surface)}))};
  const hints = new Set(ctx.mentions.flatMap(m => m.candidates.map(c => c.id)));
  const check = sop => validate({sop, message: ctx.message, lexicon, circuits, repo, session, mode: 'id', hints, mentions: retrieval.entities});
  const trace = [];
  let state = {program: null, sop: '', validation: null}, reason = null, finished = null, confirmed = null, retried = null, contrast = null, fallback = null, engineMs = 0, lastView = null;

  /** The system's own step: assemble the established slots and validate the circuit; problems become facts. */
  const assemble = view => {
    facts.remove(f => ['validator_problem', 'repair_target', 'assembly_failed', 'contrast_available'].includes(f.p));
    delete ctx.payload.contrast;
    // Problem mode: the problem questions wrote the whole circuit; the problem's names live in its value names, so the memory-name
    // check (mention_not_used) does not apply (as in LocalLLMStepByStep).
    if (ctx.payload.problem) {
      const sop = ctx.payload.problem.sop, validation = validate({sop, message: ctx.message, lexicon, circuits, repo, session, mode: 'id', hints, mentions: []});
      state = {program: validation.program ?? {}, sop, validation};
      if (validation.ok) { facts.add('assembled'); return 'assembled the problem circuit; the validator accepts it'; }
      facts.add('assembly_failed');
      return `the validator refused the problem circuit: ${validation.problems.map(p => p.code).join(', ')}`;
    }
    let program = programOf(ctx, view);
    let sop = sopOf(program, lexicon), validation = check(sop);
    if (!validation.ok && validation.problems.some(p => p.code === 'absence_needs_closed') && !ctx.payload.fixAbsence) {
      ctx.payload.fixAbsence = true;
      program = programOf(ctx, view); sop = sopOf(program, lexicon); validation = check(sop);
    }
    // The model listed a name the knowledge does not know and no question of the circuit holds a name, number or comparison: the
    // circuit would answer a different, unrestricted question.
    const listed = base.steps.find(s => s.name === 'names');
    const unrestricted = (program.queries ?? []).length && program.queries.every(q => !(q.matches ?? []).some(m => m.roles.some(r => r.value.kind !== 'var')) && !q.compares?.length && !q.any && !q.excepts?.length && !q.every);
    if (validation.ok && unrestricted && ((listed && !/^\s*none\b/i.test(listed.answer)) || ctx.mentions.length)) validation = {...validation, ok: false, problems: [{code: 'request_name_unknown', message: 'the request names something the knowledge does not know'}]};
    state = {program, sop, validation};
    if (validation.ok) {
      facts.add('assembled');
      const kind = view.rows('kind')[0]?.[0];
      if (!program.unclear && !program.constraint && kind && !['puzzle'].includes(kind)) {
        const reading = paraphraseOf(program, lexicon);
        for (const flip of flips(ctx, view, program)) {
          const text = paraphraseOf(flip.program, lexicon);
          if (text !== reading) { ctx.payload.contrast = {slot: flip.slot, reading, flipped: text, program: flip.program}; facts.add('contrast_available'); break; }
        }
      }
      return 'assembled; the validator accepts the circuit';
    }
    facts.add('assembly_failed');
    ctx.payload.problems = [];
    ctx.budget.repairs++;
    for (const p of validation.problems) {
      const slot = protocol.problemSlots.get(p.code);
      if (slot === 'unused_name') {
        const surface = JSON.parse(/"((?:\\.|[^"\\])*)"/.exec(p.message)?.[0] ?? '""');
        const mention = [...ctx.sym.mention.entries()].find(([, m]) => m.surface === surface);
        const linked = mention ? view.rows('linked', mention[0])[0]?.[1] ?? null : null;
        const n = linked ?? (mention ? [...ctx.sym.nameOf.entries()].find(([id]) => id === mention[1].candidates[0]?.id)?.[1] : null);
        if (n) { facts.add('validator_problem', 'mention_not_used', n); (ctx.payload.unusedSurface ??= {})[n] = surface; }
      } else if (slot === 'places') {
        const instances = view.rows('uses', 'q').map(r => r[1]);
        const i = instances.find(j => p.message.includes(statementOf(ctx, j)?.id ?? '\0')) ?? view.rows('main_instance', 'q')[0]?.[1];
        if (i) {
          facts.add('repair_target', 'q', i);
          ctx.payload.problems.push({instance: i, note: p.code === 'class_mismatch' ? `Not possible: ${p.message.split(';')[0]}. ` : protocol.notes.get(p.code) ?? ''});
        }
      }
    }
    return `the validator refused the circuit: ${validation.problems.map(p => p.code).join(', ')}`;
  };

  try {
    for (let step = 1; step <= MAX_DECISIONS; step++) {
      const left = total - base.steps.length;
      setFlag(facts, 'budget_left', left > 0);
      setFlag(facts, 'budget_ample', left > reserve);
      setFlag(facts, 'repairs_left', ctx.budget.repairs < ctx.budget.maxRepairs);
      observeFit(ctx, facts);
      let d = decide(protocol, facts, {control});
      engineMs += d.ms.closure + d.ms.plan;
      clauseInstances(ctx, facts, d.view);
      if (observeCoverage(ctx, facts, d.view)) { d = decide(protocol, facts, {control}); engineMs += d.ms.closure + d.ms.plan; }
      // Before the circuit is assembled: statements that share nothing are an observation, and the decision is taken again.
      if ((d.action === 'assemble' || d.kind === 'done') && observeLinks(ctx, facts, d.view)) { d = decide(protocol, facts, {control}); engineMs += d.ms.closure + d.ms.plan; }
      lastView = d.view;
      if (d.kind !== 'act') { trace.push(traceEntry({step, decision: d})); finished = d.kind; break; }
      const before = new Set(facts.map.keys()), asked = base.steps.length;
      let outcome;
      if (d.action === 'assemble') outcome = assemble(d.view);
      else {
        const def = protocol.questions.get(d.action);
        const handler = AFTER[d.action] ?? HANDLERS[def?.format];
        if (!handler) throw new Error(`the protocol question ${d.action} has no handler for its answer format ${def?.format}`);
        onProgress({phase: d.action});
        const out = await handler({protocol, prefix, ctx, facts, view: d.view, oracle: base, def, action: d.action, arg: d.arg});
        if (out?.avoided) ctx.avoided.push({question: `${d.action} ${d.arg}`.trim(), why: out.avoided});
        outcome = describe(out);
        facts.add('answered', d.action, d.arg);
        if (d.action === 'ask_contrast') {
          const pick = facts.rows('contrast_pick')[0]?.[0];
          contrast = {slot: ctx.payload.contrast.slot, pick};
          confirmed = pick === 'reading';
          if (pick === 'flipped') {
            const sop = sopOf(ctx.payload.contrast.program, lexicon), validation = check(sop);
            if (validation.ok) { state = {program: ctx.payload.contrast.program, sop, validation}; retried = ctx.payload.contrast.slot; }
          }
        }
        // The declared effects of the question besides its answer (a re-ask clears a refused assembly, a wrong part discards the
        // assembled reading, a places re-ask is made once per instance).
        const effect = protocol.effects.get(d.action) ?? {adds: [], removes: []};
        const ground = atom => atom.map(t => t === '?a' ? d.arg : t);
        for (const atom of effect.removes.map(ground)) facts.remove(f => f.p === atom[0] && atom.slice(1).every((t, k) => t.startsWith('?') || f.args[k] === t));
        for (const atom of effect.adds.map(ground)) if (atom[0] !== 'assembled' && atom.slice(1).every(t => !t.startsWith('?'))) facts.add(...atom);
      }
      trace.push(traceEntry({step, decision: d, action: d.action, arg: d.arg, outcome, added: [...facts.map.keys()].filter(k => !before.has(k)), asked: base.steps.slice(asked)}));
    }
  } catch (error) {
    if (!(error instanceof Unreadable) && error.code !== 'oracle_failed') throw error;
    reason = error.message;
  }
  // The strategy writes every circuit itself: when the established slots cannot be assembled into a circuit the validator accepts
  // (or no question can complete it), it says honestly that it could not formalize the request from this knowledge.
  const noRoute = finished === 'stuck' && !base.steps.length && !state.program;
  if (!reason && !(finished === 'done' && state.validation?.ok)) {
    if (state.sop) fallback = {sop: state.sop, problems: state.validation?.ok ? ['not_confirmed'] : (state.validation?.problems ?? []).map(p => p.code)};
    const program = {unclear: 'relation_not_in_memory'};
    const sop = sopOf(program, lexicon);
    state = {program, sop, validation: check(sop)};
  }
  const defaults = lastView ? defaultsFired(protocol, facts, lastView).filter(d => !(d.atom === 'confirmed' && facts.has('answered', 'ask_contrast', 'none'))) : [];
  const usage = {turns: base.steps.length, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0};
  for (const s of base.steps) { usage.input_tokens += s.input_tokens; usage.output_tokens += s.output_tokens; usage.cache_read_tokens += s.cached ?? 0; }
  const {sop, validation} = state;
  const ok = !reason && validation?.ok === true;
  const status = ok ? 'validated' : reason ? 'failed' : 'invalid';
  const unclear = ok ? unclearKind(validation.program) : null;
  const decisions = trace.length;
  const report = {strategy: 'InternalReasoningStepByStep', control, protocol: `${protocol.id}@${protocol.version}`, kind: lastView?.rows('kind')[0]?.[0] ?? null,
    questions: base.steps.length, decisions, avoided: {defaults: defaults.length, auto: ctx.avoided.length}, engine_ms: Math.round(engineMs), engine_ms_per_decision: decisions ? Math.round(engineMs / decisions * 10) / 10 : 0,
    controls: trace.reduce((m, e) => ({...m, [e.control]: (m[e.control] ?? 0) + 1}), {}), contrast, confirmed, retried, no_route: noRoute, ...(fallback ? {fallback} : {})};
  return {
    circuits: ok ? splitCircuits(sop).parts.map(p => ({file: 'query.sop', role: 'query', text: p.text, origin: 'internal_reasoning_step_by_step'})) : [],
    ok, status, sop, validation, program: validation?.program ?? null, unclear,
    rounds: 1, runs: [{round: 0, phase: 'internal_reasoning', ok: !reason, duration_ms: Date.now() - started, usage}], usage,
    duration_ms: Date.now() - started, backend: 'internal-reasoning', model, report: JSON.stringify(report),
    context_version: `internal-reasoning-${protocol.version}`, mode: 'id', retrieval, vocabulary_dialog: {max_rounds: 0, rounds: 0, expansions: []},
    steps: base.steps, trace, explanation: explainTrace(trace, {fallback, defaults}), defaults, avoided: ctx.avoided, engine_ms: Math.round(engineMs),
    confirmed, retried, contrast, method: control === 'plan' ? 'IR' : 'IR-greedy', ...(fallback ? {fallback} : {}), ...(reason ? {reason} : {}),
    unlinked: (validation?.advice ?? []).map(a => ({code: a.code, message: a.message})),
  };
}
