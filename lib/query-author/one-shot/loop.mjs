/**
 * The validate-and-repair loop of the query author (b), identical for every backend: ask the backend for `query.sop`, validate it
 * (validate.mjs), and while problems (or fixable advice) remain and rounds are left, send the validator's output back. The result
 * never throws for a backend failure: `status` is `validated`, `invalid` (problems remain after the last round) or `failed` (the
 * backend did not deliver: not installed, timeout, error), with a `reason`.
 *
 * Restored on 2026-10-14 from ChatSOP's archive (probably_obsolete/one-shot-formalization/, archived 2026-10-02) for the MRP formalize
 * strategies DirectSOP and SchemaGuidedLLM (DS025 "The catalog"); the archived names LLMDirect, CodingAgent and LocalLLMDirect stay archived.
 */
import fs from 'node:fs';
import {buildContext} from './context.mjs';
import {validateQuery, unclearKind} from '../validate.mjs';
import {nearestPredicates} from '../retrieval.mjs';
import {splitCircuits} from '../session.mjs';
import {one, many, isMatch, parseMatch} from '../../../sop/parser.mjs';
import {parseCondition} from '../../../sop/conditions.mjs';
import {collectNeighbourhood} from '../neighbourhood.mjs';

const ZERO = () => ({turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0});

const VOCABULARY_PROBLEMS = new Set(['unknown_predicate', 'unknown_body_predicate', 'relation_not_in_vocabulary', 'undeclared_role', 'role_not_declared', 'class_mismatch', 'type_mismatch', 'role_mismatch', 'condition_misuse']);
function vocabularyIssue(validation) {
  if (unclearKind(validation?.program) === 'relation_not_in_memory') return {code: 'relation_not_in_memory', terms: []};
  const problems = [...(validation?.problems ?? []), ...(validation?.advice ?? [])].filter(p => VOCABULARY_PROBLEMS.has(p.code));
  if (!problems.length) return null;
  return {code: problems[0].code, terms: problems.flatMap(p => [
    ...(p.predicate ? [p.predicate] : []), ...[...p.message.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => JSON.parse(m[0]))])};
}

/** Declared types warrant a dialog; a sampled reversal only warrants an execution preview. */
function schemaDiagnostic(program, neighbourhood, lexicon) {
  for (const wire of program?.wires ?? []) {
    if (wire.type !== 'query') continue;
    const blocks = [];
    for (const text of [...many(wire, 'where'), ...many(wire, 'scope')]) parseCondition(text, leaf => {
      if (isMatch(leaf)) blocks.push(parseMatch(leaf));
      return leaf;
    });
    for (const block of blocks) {
      const schema = neighbourhood.predicates.find(p => p.id === block.relation) ?? lexicon?.predicates?.[block.relation];
      if (!schema) continue;
      for (const role of block.roles) {
        const type = schema.roles?.find(r => r.name === role.name)?.type;
        const value = role.value;
        if (!type || typeof value === 'string' && /^[?$]/.test(value)) continue;
        if (type === 'integer' && !Number.isSafeInteger(value) && !(typeof value === 'string' && /^-?\d+$/.test(value)))
          return {code: 'type_mismatch', terms: [schema.id]};
        if (typeof value === 'string' && lexicon.isClass?.(type)) {
          const bound = lexicon.resolve?.(value, {kind: 'entity', language: 'en'});
          if (bound?.status === 'bound' && !lexicon.classesOf(bound.id).has(type))
            return {code: 'class_mismatch', terms: [schema.id]};
        }
      }
      if (block.polarity !== 'affirmed' || one(wire, 'mode') === 'count') continue;
      if (schema?.roles?.length !== 2 || block.roles.length !== 2) continue;
      const values = schema.roles.map(r => block.roles.find(v => v.name === r.name)?.value);
      const resolved = values.map(v => typeof v !== 'string' || /^[?$]/.test(v) ? v : lexicon.resolve?.(v, {kind: 'entity', language: 'en'}));
      const args = resolved.map(v => typeof v === 'object' ? v?.status === 'bound' ? v.id : null : v);
      if (args.some(v => v === null || v === undefined)) continue;
      const fits = (fact, swapped) => args.every((a, i) => typeof a === 'string' && a.startsWith('?') || fact.a[swapped ? 1 - i : i] === a);
      const examples = (schema.examples ?? []).map(e => e.atom).filter(a => a && !a.neg);
      if (!examples.some(f => fits(f, false)) && examples.some(f => fits(f, true)))
        return {code: 'plausible_swapped_order', terms: [schema.id]};
    }
  }
  return null;
}

/** A closed schema (SchemaGuidedLLM) admits no session vocabulary: a definition or an assumption goes back for repair. */
const OPEN_VOCABULARY = new Set(['predicate', 'rule', 'default', 'aggregate', 'assumed']);
function closedValidation(validate) {
  return args => {
    const v = validate(args);
    const extra = (v.program?.wires ?? []).filter(w => OPEN_VOCABULARY.has(w.type)).map(w => ({code: 'schema_closed', wire: w.id, message: `the schema is closed: a ${w.type} wire is not allowed; use a listed predicate, an unparsed span or unclear kind relation_not_in_memory`}));
    return extra.length ? {...v, ok: false, problems: [...(v.problems ?? []), ...extra]} : v;
  };
}

export async function authorQuery({message, lexicon, circuits, repo = null, session = null, addressee = null, execute = null, selfCheck = false, vocabularyDialog = true, maxVocabularyBytes = 24_000, backend, folder = null, maxFixRounds = 3, mode = 'id', k = 24, indexMax = 300, validate: validateOpen = validateQuery, admit, closed = false, retrieval = null, onProgress = () => {}}) {
  const started = Date.now();
  const validate = closed ? closedValidation(validateOpen) : validateOpen;
  const context = buildContext({message, lexicon, circuits, repo, session, mode, k, indexMax, maxVocabularyBytes, vocabulary: backend.kind === 'completion' ? null : undefined, addressee, closed, extra: retrieval?.predicates ?? []});
  if (folder) fs.mkdirSync(folder, {recursive: true});
  const history = [];
  const runs = [];
  const usage = ZERO();
  let validation = null, reason = null, best = null, report = '', latest = '';
  const dialog = [];
  const generate = async phase => {
    const round = runs.length;
    onProgress({phase, round, max_fix_rounds: maxFixRounds});
    const out = await backend.generate({context, history, folder});
    runs.push({round, phase, ok: out.ok, duration_ms: out.duration_ms, usage: out.usage, ...(out.served ? {served: out.served} : {}), ...(out.fallback ? {fallback: out.fallback} : {}), ...(out.reason ? {reason: out.reason} : {})});
    for (const key of Object.keys(usage)) usage[key] += out.usage?.[key] ?? 0;
    if (out.report) report = out.report;
    latest = out.sop ?? '';
    if (!out.ok || !out.sop?.trim()) { reason = out.reason ?? 'the backend returned nothing'; best = null; return false; }
    onProgress({phase: 'validating', round});
    validation = validate({sop: out.sop, message, lexicon, circuits, repo, session, mode, hints: context.hints, mentions: context.retrieval.entities, ...(admit ? {admit} : {})});
    best = validation.ok ? {sop: out.sop, validation, round} : null;
    return true;
  };
  for (let round = 0; round <= maxFixRounds; round++) {
    if (!await generate(round === 0 ? 'writing' : 'fixing')) break;
    while (vocabularyDialog && dialog.length < 2) {
      let issue = vocabularyIssue(validation);
      const diagnostic = !issue && best ? schemaDiagnostic(best.validation.program, context.retrieval.neighbourhood, lexicon) : null;
      if (diagnostic && diagnostic.code !== 'plausible_swapped_order') issue = diagnostic;
      if (!issue && diagnostic && execute) {
        const packet = await execute(best.sop);
        const empty = packet?.complete !== false && (packet?.status === 'unknown' ||
          ['supported', 'refuted'].includes(packet?.status) && [packet.answers, packet.rows].some(rows => Array.isArray(rows) && rows.length === 0));
        issue = ['type_mismatch', 'role_mismatch', 'unknown_predicate'].includes(packet?.reason)
          ? {code: packet.reason, terms: []} : empty ? diagnostic : null;
      }
      if (!issue) break;
      const neighbourhood = collectNeighbourhood({message, lexicon, circuits, repo, session, hops: 2, terms: [...context.retrieval.predicates, ...issue.terms]});
      const expanded = buildContext({message, lexicon, circuits, repo, session, neighbourhood, mode, k, indexMax, maxVocabularyBytes, vocabulary: null, addressee, closed, extra: retrieval?.predicates ?? []});
      context.retrieval.neighbourhood = neighbourhood;
      context.retrieval.predicates = [...new Set([...context.retrieval.predicates, ...expanded.retrieval.predicates])];
      const focused = expanded.files.find(f => f.path === 'input/candidates.md').text;
      const entities = neighbourhood.entities.map(id => JSON.stringify(id)).join(', ') || 'the request entities';
      const followup = {code: 'symbolic_vocabulary_dialog', message: `${issue.code}: these relations exist around ${entities}.\n${focused}\nDefine the missing term as a session predicate and rule over existing relations, or ask the user a precise question with an unclear marker. If an existing derived relation fits, use it instead; never override memory. For a suspected role swap, re-read the examples; an empty result is not proof that a swap is correct. Preserve every restriction and never assert or answer. Write the entire query.sop.`};
      dialog.push({round: runs.length, trigger: issue.code, hops: 2, predicates: expanded.retrieval.predicates, bytes: Buffer.byteLength(focused)});
      history.push({sop: latest, problems: [...validation.problems, ...validation.advice, followup]});
      if (!await generate('vocabulary_dialog')) break;
    }
    if (reason || round === maxFixRounds || validation.ok && !validation.advice.length) break;
    history.push({sop: latest, problems: [...validation.problems, ...validation.advice]});
  }
  let check = null;
  if (best && execute && selfCheck && !unclearKind(best.validation.program)) {
    const packet = await execute(best.sop);
    const shape = {status: packet?.status ?? 'blocked', cardinality: packet?.count !== undefined || packet?.at_least !== undefined ? 1 : packet?.answers?.length ?? packet?.rows?.length ?? 0,
      circuit: best.validation.program.wires.filter(w => w.type === 'query' || w.type === 'constraint').map(w => `${w.id}: ${one(w, 'mode', one(w, 'select') ? 'select' : 'exists')}; ${Object.entries(w.fields).map(([k, vs]) => `${k} ${vs.join(' ')}`).join('; ').replace(/\s+/g, ' ')}`).join(' | ')};
    onProgress({phase: 'self_check', round: runs.length});
    const out = await backend.generate({context, folder, history: [...history, {sop: best.sop, problems: [{code: 'answer_shape_self_check', message: `Execution shape (no answer values): ${JSON.stringify(shape)}. Re-read the request and its circuit. Preserve every name, quantifier and comparison. Write the whole circuit unchanged if faithful, otherwise revise once. Never answer.`}]}]});
    runs.push({round: runs.length, phase: 'self_check', ok: out.ok, duration_ms: out.duration_ms, usage: out.usage});
    latest = out.sop ?? '';
    for (const k of Object.keys(usage)) usage[k] += out.usage?.[k] ?? 0;
    check = {shape, status: 'unchanged', revised: false};
    if (!out.ok || !out.sop?.trim()) check = {...check, status: 'unavailable', reason: out.reason ?? 'no circuit'};
    else {
      const checked = validate({sop: out.sop, message, lexicon, circuits, repo, session, mode, hints: context.hints, mentions: context.retrieval.entities, ...(admit ? {admit} : {})});
      if (!checked.ok) { best = null; validation = checked; reason = null; check = {...check, status: 'invalid'}; }
      else {
        check.revised = out.sop.trim() !== best.sop.trim();
        check.status = check.revised ? 'revised' : 'unchanged';
        best = {sop: out.sop, validation: checked, round: runs.length - 1};
        if (check.revised) await execute(best.sop);
      }
    }
  }
  usage.cost_usd = Math.round(usage.cost_usd * 1e6) / 1e6;
  const final = best ?? null;
  const status = final ? 'validated' : reason ? 'failed' : 'invalid';
  const chosen = final ?? {sop: latest, validation};
  const unclear = final ? unclearKind(final.validation.program) : null;
  return {
    circuits: final ? splitCircuits(final.sop).parts.map(p => ({file: p.type === 'query' || p.type === 'constraint' ? 'query.sop' : 'session.sop', role: ['predicate', 'rule', 'default'].includes(p.type) ? 'definition' : p.type === 'assumed' ? 'assumption' : 'query', text: p.text, origin: 'coding_agent'})) : [],
    ...(unclear === 'relation_not_in_memory' ? {closest: nearestPredicates(message, lexicon, 8).map(id => ({id, roles: (lexicon.predicates[id].roles ?? []).map(r => r.name + ':' + r.type)}))} : {}),
    ok: Boolean(final), status, sop: chosen.sop, validation: chosen.validation ?? validation, program: chosen.validation?.program ?? null, unclear,
    rounds: runs.length, runs, usage, duration_ms: Date.now() - started, backend: backend.id, model: backend.model ?? null, report, context_version: context.version,
    mode, retrieval: context.retrieval, vocabulary_dialog: {max_rounds: 2, rounds: dialog.length, expansions: dialog}, ...(reason ? {reason} : {}), ...(check ? {self_check: check} : {}),
    unlinked: (final?.validation.advice ?? []).map(a => ({code: a.code, message: a.message})),
    // What each repair or dialog round was asked to fix: the problem codes sent back to the author (the trace shows them).
    repairs: history.map((h, i) => ({round: i + 1, problems: [...new Set(h.problems.map(p => p.code))]})),
  };
}
