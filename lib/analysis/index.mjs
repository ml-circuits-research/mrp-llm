/**
 * The analyzer (DS022 "Analysis procedures", owner request of 2026-10-03): analysis PROCEDURES defined as rules in a base memory,
 * applied by the reasoners to the wires a document left in a session or a base memory (the document layer, with provenance: document,
 * location, quote). Typical uses: contradictions, illogical or wrong statements, KPIs and indicators, quality rubrics.
 *
 *   analyzeSession(source, procedures?, options?)   runs the selected procedures; returns the analysis packet (below)
 *   analysisSource(source, options?)                the circuits of a source with the document layer marked
 *   listProcedures(source)                          the analysis procedures a source holds (no run)
 *
 * `source` is a session `{sessions, id}`, a base memory `{memories, id}`, or `{circuits: [{name, text, provenance?, document?}]}`. The
 * document layer is the circuits named by `options.documents` (circuit names, or document names or SHA-256 of an ingestion's provenance), else those whose provenance says `kind: document` (ingestion v1 and v2),
 * else those marked `document: true`. `procedures` is null (every procedure tagged `analysis`) or a list of procedure ids.
 *
 * A run (no model is called): the members of the selected procedures, the declarations they and the document use, the document wires and
 * the document view (./view.mjs) form one theory; parameter overrides (`options.parameters` {name: value}) replace the member facts of
 * `analysis_parameter`. Each procedure's queries (the violations of its integrity members, and its `report` lines) run through the
 * StrategyRouter (`options.reasoning`: auto, or one engine id run exactly; the oracle verifies as routed), and every row is explained by
 * the oracle (`mode explain`): the proof, the support set, and from it the document wires with their provenance.
 *
 * The packet ({object: 'chatsop.analysis'}): documents, procedures, findings [{id, procedure, procedures, rule {id, message, severity,
 * source}, severity, witness, evidence [{wire, type, sop, document, location, quote}], rules, proof, route}], measures [{id, procedure,
 * predicate, atom, values, evidence, rules, proof, route}], counts, view {facts, literals}, lint, parameters, text (the report rendered
 * from the conversation layer's reply wires, ./report.mjs), ms.
 */
import {createHash} from 'node:crypto';
import {prepare, ask} from '../../reasoning/strategies/js-reference/index.mjs';
import {routedAsk} from '../../reasoning/router/index.mjs';
import {wireText} from '../../sop/knowledge/index.mjs';
import {wireIndex, wireOf, analysisProcedures, memberLint} from './library.mjs';
import {documentView, wiresOf, predicatesOf, termText, atomText, VIEW_PREDICATES} from './view.mjs';
import {renderReport} from './report.mjs';

export {wireIndex, analysisProcedures, memberLint} from './library.mjs';
export {documentView, termText, atomText, VIEW_PREDICATES} from './view.mjs';
export {renderReport} from './report.mjs';

const THEORY_TYPES = new Set(['predicate', 'fact', 'rule', 'default', 'integrity', 'aggregate']);
const sha = text => createHash('sha256').update(text).digest('hex');
const fail = (message, code, status = 400) => Object.assign(new Error(message), {code, status});
const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim() ?? null;
const decode = v => { if (v === null) return null; try { return JSON.parse(v); } catch { return v; } };
const isDocumentRecord = r => (r?.kind === 'document' ? r : null);

/** sha256 of a circuit text → its document provenance, from provenance records ({sha256, source|request}). */
function provenanceIndex(records) {
  const out = new Map();
  for (const r of records) {
    const p = isDocumentRecord(r.source) ?? isDocumentRecord(r.request);
    if (r.sha256 && p) out.set(r.sha256, p);
  }
  return out;
}
const safeProvenance = (store, id) => { try { return store.provenance(id); } catch { return []; } };

/** The circuits of a source, each {name, text, provenance, document}. */
export function analysisSource(source, {documents = null} = {}) {
  let kind, id, circuits, records = [];
  if (source?.sessions && source.id) {
    kind = 'session'; id = source.id;
    const {sessions} = source;
    const info = sessions.info(id);
    records = [...safeProvenance(sessions, id)];
    if (sessions.memories && info.base?.id) {
      records.push(...safeProvenance(sessions.memories, info.base.id));
      try { for (const l of sessions.memories.layers(info.base.id)) records.push(...safeProvenance(sessions.memories, l.id)); } catch { /* a base without layers */ }
    }
    circuits = [...sessions.baseCircuits(id), ...sessions.circuits(id)];
  } else if (source?.memories && source.id) {
    kind = 'memory'; id = source.id;
    const {memories} = source;
    records = [...safeProvenance(memories, id)];
    for (const l of memories.layers(id)) records.push(...safeProvenance(memories, l.id));
    circuits = memories.layeredCircuits(id);
  } else if (Array.isArray(source?.circuits)) {
    kind = 'circuits'; id = source.id ?? null;
    circuits = source.circuits;
  } else throw fail('Analyse a session {sessions, id}, a base memory {memories, id} or circuits {circuits}', 'invalid_source');
  const bySha = provenanceIndex(records);
  // `documents` names circuits, or documents by their provenance name or SHA-256 (every circuit an ingestion stored for them).
  const named = documents ? new Set(documents) : null;
  const out = circuits.map(c => {
    const provenance = c.provenance ?? bySha.get(sha(c.text)) ?? null;
    const document = named ? [c.name, provenance?.document, provenance?.document_sha256].some(k => k && named.has(k)) : Boolean(c.document || provenance?.kind === 'document');
    return {name: c.name, text: c.text, provenance, document};
  });
  if (named) for (const n of named) if (!out.some(c => c.document && [c.name, c.provenance?.document, c.provenance?.document_sha256].includes(n))) throw fail(`No circuit or ingested document named ${JSON.stringify(n)} in the ${kind}`, 'unknown_document', 404);
  return {kind, id, circuits: out};
}

/** The analysis procedures a source holds, without running them. */
export function listProcedures(source) {
  const src = analysisSource(source);
  const index = wireIndex(src.circuits);
  const procedures = analysisProcedures(index);
  return {procedures: procedures.map(({id, description, tags, members, reports, integrity, parameters, circuit}) => ({id, description, tags, members, reports: reports.map(r => r.text), integrity, parameters, circuit})), lint: memberLint(procedures, index)};
}

/** The select query of an atom pattern: all its variables, or a yes/no question when it has none. */
function patternQuery(text, terms) {
  const vars = [...new Set(terms.filter(t => t.startsWith('?')))];
  return vars.length ? `@q query\n  select ${vars.join(' ')}\n  where ${text}\n` : `@q query\n  mode exists\n  where ${text}\n`;
}

/** The ground atom of a pattern under a row's bindings. */
function groundText(predicate, terms, row) {
  return [predicate, ...terms.map(t => (t.startsWith('?') ? termText(row[t.slice(1)]) : t))].join(' ');
}

const routeSummary = r => (r ? {chosen: r.chosen ?? null, rule: r.rule ?? null, requested: r.requested ?? null, verification: r.verification ? {checked: r.verification.checked ?? null, outcome: r.verification.outcome ?? null} : null} : null);

/**
 * Runs the selected analysis procedures over the document layer of `source`. Options: `documents` (circuit names of the document layer),
 * `parameters` ({name: value} overrides), `reasoning` ('auto' or an engine id), `verify` ('auto'|'always'|'never'), `budget` (oracle
 * limits), `render` (false: no text).
 */
export function analyzeSession(source, procedures = null, options = {}) {
  const t0 = performance.now();
  const {parameters = {}, reasoning = 'auto', verify = 'auto', budget = {}, render = true} = options;
  const src = analysisSource(source, options);
  const documentCircuits = src.circuits.filter(c => c.document);
  if (!documentCircuits.length) throw fail('The source has no document layer: ingest a document first, or name its circuits in documents', 'no_document_layer', 422);
  const index = wireIndex(src.circuits.filter(c => !c.document));
  const ids = procedures === null || procedures === undefined || procedures === 'all' ? null : [].concat(procedures);
  const procs = analysisProcedures(index, {ids});
  if (!procs.length) throw fail('No analysis procedure in the source: import a library such as analysis-core-v1, or add a procedure tagged analysis', 'no_procedures', 422);
  const lint = memberLint(procs, index);

  // Parameter overrides replace the member facts of analysis_parameter by name.
  const known = new Map(procs.flatMap(p => p.parameters.map(x => [x.name, x.value])));
  for (const [name, value] of Object.entries(parameters)) {
    if (!known.has(name)) throw fail(`Unknown parameter ${JSON.stringify(name)}; the selected procedures take ${[...known.keys()].join(', ') || 'none'}`, 'unknown_parameter');
    if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(`Parameter ${name} must be a number`, 'invalid_parameter');
  }
  const overridden = new Set(Object.keys(parameters));
  const memberIds = [...new Set(procs.flatMap(p => p.members))];
  const members = memberIds.map(id => wireOf(index.get(id))).filter(w => w && THEORY_TYPES.has(w.type))
    .filter(w => !(w.type === 'fact' && /^analysis_parameter\s/.test(field(w, 'holds') ?? '') && overridden.has(field(w, 'holds').split(/\s+/)[1])));
  const overrideText = Object.entries(parameters).map(([name, value]) => `@ap_${name} fact\n  holds analysis_parameter ${name} ${value}\n  source "analysis run parameter"\n`).join('\n');
  const overrides = overrideText ? wiresOf(overrideText, 'parameters') : [];

  // The document layer.
  const docWires = [], wireCircuit = new Map();
  for (const c of documentCircuits) for (const w of wiresOf(c.text, `document circuit ${c.name}`)) {
    if (!THEORY_TYPES.has(w.type)) continue;
    docWires.push(w);
    wireCircuit.set(w.id, c);
  }
  const memberSet = new Set([...members, ...overrides].map(w => w.id));
  const clash = docWires.find(w => memberSet.has(w.id));
  if (clash) throw fail(`The document wire ${clash.id} has the id of a procedure member`, 'id_collision', 422);

  // Declarations of every predicate the run reads or writes that the document does not declare itself.
  const declaredByDoc = new Set(docWires.filter(w => w.type === 'predicate').map(w => w.id));
  const used = new Set([...VIEW_PREDICATES]);
  for (const w of [...members, ...docWires]) for (const p of predicatesOf(w)) used.add(p);
  for (const p of procs) for (const r of p.reports) used.add(r.predicate);
  const declarations = [...used].filter(p => !declaredByDoc.has(p) && !memberSet.has(p)).map(p => index.get(p)).filter(e => e?.type === 'predicate').map(wireOf).filter(Boolean);
  // Display labels of entity symbols: the document's entity wires, then the memory's (looked up only for the symbols reported).
  const docLabels = new Map();
  for (const c of documentCircuits) for (const w of wiresOf(c.text, c.name)) if (w.type === 'entity') { const l = w.fields.find(f => f.key === 'label' && /^en\s/.test(f.value.trim())); if (l) docLabels.set(w.id, decode(l.value.trim().slice(3))); }
  const labels = new Map();
  const labelOf = v => {
    if (typeof v !== 'string') return null;
    if (!labels.has(v)) {
      const e = index.get(v);
      const m = e?.type === 'entity' ? /^\s+label en ("(?:[^"\\]|\\.)*")/m.exec(e.text) : null;
      labels.set(v, docLabels.get(v) ?? (m ? decode(m[1]) : null));
    }
    return labels.get(v);
  };

  // The document view, then the theory of the run.
  const runWires = [...declarations, ...members, ...overrides];
  const taken = new Set([...docWires, ...runWires].map(w => w.id));
  let prefix = 'av';
  while ([...taken].some(id => id.startsWith(prefix + '_'))) prefix += 'v';
  const view = documentView({documentWires: docWires, runWires: runWires.filter(w => w.type !== 'integrity'), budget, prefix});
  const theory = [...runWires, ...docWires].map(wireText).join('\n\n') + '\n\n' + view.text;
  const handle = prepare(theory);

  const evidenceOf = id => {
    const w = docWires.find(x => x.id === id);
    if (!w) return null;
    const c = wireCircuit.get(id), prov = c?.provenance ?? null;
    const lines = Array.isArray(prov?.lines) ? `lines ${prov.lines[0]}-${prov.lines[1]}` : null;
    return {wire: id, type: w.type, sop: wireText(w), document: prov?.document ?? prov?.title ?? c?.name ?? null, location: decode(field(w, 'source')) ?? lines ?? c?.name ?? null, quote: decode(field(w, 'quote')), circuit: c?.name ?? null};
  };
  const explainRow = atom => {
    const packet = ask({handle, query: `@q query\n  mode explain\n  where ${atom}\n`}, budget);
    const usedIds = (packet.used ?? []).map(u => u.id);
    const docs = new Set(), rules = new Set(), viewAtoms = [];
    for (const id of usedIds) {
      const v = view.facts.get(id);
      if (v) { v.documents.forEach(d => docs.add(d)); v.rules.forEach(r => { if (!docWires.some(w => w.id === r)) rules.add(r); }); viewAtoms.push({fact: id, [v.predicate === 'keyed_value' ? 'keyed' : v.polarity]: v.atom}); }
      else if (docWires.some(w => w.id === id)) docs.add(id);
      else rules.add(id);
    }
    return {status: packet.status, evidence: [...docs].map(evidenceOf).filter(Boolean), rules: [...rules], view: viewAtoms, proof: packet.proof ?? null, used: packet.used ?? []};
  };

  const findings = new Map(), measures = [], routes = [];
  const runPattern = (proc, text, predicate, terms) => {
    const packet = routedAsk({handle, query: patternQuery(text, terms), requested: reasoning, verify, budget, seed: 1});
    routes.push({procedure: proc.id, query: text, status: packet.status, route: routeSummary(packet.route)});
    if (packet.status === 'unsupported' || packet.status === 'error') return {packet, rows: []};
    const rows = Array.isArray(packet.rows) ? packet.rows : packet.status === 'supported' && !terms.some(t => t.startsWith('?')) ? [{}] : [];
    return {packet, rows};
  };
  for (const proc of procs) {
    for (const rule of proc.integrity) {
      const {packet, rows} = runPattern(proc, `violation ${rule.id} ?witness`, 'violation', ['?witness']);
      for (const row of rows) {
        const witness = row.witness;
        const key = `${rule.id}\u0000${termText(witness)}`;
        if (findings.has(key)) { findings.get(key).procedures.push(proc.id); continue; }
        const why = explainRow(`violation ${rule.id} ${termText(witness)}`);
        findings.set(key, {id: `${rule.id}:${termText(witness)}`, procedure: proc.id, procedures: [proc.id], rule, severity: rule.severity, witness, witness_label: labelOf(witness), ...why, route: routeSummary(packet.route)});
      }
    }
    for (const r of proc.reports) {
      const {packet, rows} = runPattern(proc, r.text, r.predicate, r.terms);
      for (const row of rows) {
        const atom = groundText(r.predicate, r.terms, row);
        const same = measures.find(m => m.atom === atom);
        if (same) { if (!same.procedures.includes(proc.id)) same.procedures.push(proc.id); continue; }
        const values = Object.fromEntries(r.terms.map((t, i) => [t.startsWith('?') ? t.slice(1) : `arg${i + 1}`, t.startsWith('?') ? row[t.slice(1)] : t]));
        measures.push({id: atom, procedure: proc.id, procedures: [proc.id], predicate: r.predicate, pattern: r.text, atom, values, labels: Object.fromEntries(Object.entries(values).filter(([, v]) => labelOf(v)).map(([k, v]) => [k, labelOf(v)])), ...explainRow(atom), route: routeSummary(packet.route)});
      }
    }
  }
  const list = [...findings.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || a.id.localeCompare(b.id));
  const result = {
    object: 'chatsop.analysis', source: {kind: src.kind, id: src.id},
    documents: documentCircuits.map(c => ({circuit: c.name, document: c.provenance?.document ?? c.provenance?.title ?? c.name, wires: docWires.filter(w => wireCircuit.get(w.id) === c).length})),
    procedures: procs.map(p => ({id: p.id, description: p.description, tags: p.tags, members: p.members.length, integrity: p.integrity.map(i => i.id), reports: p.reports.map(r => r.text), parameters: p.parameters.map(x => ({...x, value: overridden.has(x.name) ? parameters[x.name] : x.value, overridden: overridden.has(x.name)}))})),
    findings: list, measures,
    counts: {findings: list.length, errors: list.filter(f => f.severity === 'error').length, warnings: list.filter(f => f.severity !== 'error').length, measures: measures.length},
    view: {facts: view.facts.size, literals: view.literals, exhausted: view.exhausted ?? null},
    routes: {requested: reasoning, queries: routes.length, engines: [...new Set(routes.map(r => r.route?.chosen).filter(Boolean))], unsupported: routes.filter(r => r.status === 'unsupported').map(r => ({procedure: r.procedure, query: r.query}))},
    lint,
    ms: 0,
  };
  // The report's sentences are reply wires of the conversation layer in use; a layer that lacks them (a stored copy older than the
  // shipped one, renewed by tools/refresh-seed-memories.mjs) leaves the text out and says why, the analysis itself stands.
  if (render) {
    try { result.text = renderReport(result); }
    catch (error) { if (!['reply_missing', 'reply_slot_missing', 'reply_layer_missing'].includes(error.code)) throw error; result.text = null; result.render_error = {code: error.code, message: error.message}; }
  }
  result.ms = Math.round(performance.now() - t0);
  return result;
}
