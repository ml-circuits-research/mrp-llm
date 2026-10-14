/**
 * Analysis procedures over HTTP (DS022 "Analysis procedures", docs/analysis.html, docs/api.html):
 *
 *   POST /v1/sessions/{id}/analyze               {procedures?, parameters?, documents?, reasoning?, verify?, proofs?}: run the analysis
 *   POST /v1/memories/{id}/analyze               the same over a base memory
 *   GET  /v1/sessions/{id}/analysis-procedures   the analysis procedures the session holds (no run)
 *   GET  /v1/memories/{id}/analysis-procedures   the same for a base memory
 *
 * The answer is the analysis packet of lib/analysis (findings with their rule, severity and the document's own words, measures, the
 * rendered report text); `proofs: false` leaves the oracle's proof DAGs out. A session is visible to its user and to an administrator.
 * Nothing is written: an analysis reads the memory and runs the engines (no model is called).
 */
import {analyzeSession, listProcedures} from '../lib/analysis/index.mjs';
import {registerAnalysisMode} from '../lib/analysis/adapter.mjs';

export const ANALYSIS_ENDPOINTS = Object.freeze([
  {method: 'POST', path: '/v1/sessions/{id}/analyze', capability: 'sessions.analyze', body: ['procedures', 'parameters', 'documents', 'reasoning', 'verify', 'proofs']},
  {method: 'POST', path: '/v1/memories/{id}/analyze', capability: 'memories.analyze', body: ['procedures', 'parameters', 'documents', 'reasoning', 'verify', 'proofs']},
  {method: 'GET', path: '/v1/sessions/{id}/analysis-procedures', capability: 'sessions.analysis_procedures'},
  {method: 'GET', path: '/v1/memories/{id}/analysis-procedures', capability: 'memories.analysis_procedures'},
]);

const bad = (message, code = 'invalid_parameter', status = 400) => Object.assign(new Error(message), {status, code});
const ID = '([a-z0-9][a-z0-9_-]{0,63})';
const BODY = ANALYSIS_ENDPOINTS[0].body;

/** The checked options of an analyze request. */
export function checkAnalyzeBody(body) {
  const extra = Object.keys(body ?? {}).filter(k => !BODY.includes(k));
  if (extra.length) throw bad(`Unsupported parameter ${JSON.stringify(extra[0])}; accepted: ${BODY.join(', ')}`, 'unsupported_parameter');
  const list = (k, v) => { if (v !== undefined && (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string' || !x))) throw bad(`${k} must be a non-empty array of strings`); return v ?? null; };
  const procedures = list('procedures', body.procedures), documents = list('documents', body.documents);
  if (body.parameters !== undefined && (typeof body.parameters !== 'object' || body.parameters === null || Array.isArray(body.parameters))) throw bad('parameters must be an object {name: number}');
  for (const k of ['reasoning', 'verify']) if (body[k] !== undefined && typeof body[k] !== 'string') throw bad(`${k} must be a string`);
  if (body.verify !== undefined && !['auto', 'always', 'never'].includes(body.verify)) throw bad('verify must be auto, always or never');
  if (body.proofs !== undefined && typeof body.proofs !== 'boolean') throw bad('proofs must be true or false');
  return {procedures, documents, parameters: body.parameters ?? {}, reasoning: body.reasoning ?? 'auto', verify: body.verify ?? 'auto', proofs: body.proofs !== false};
}

const withoutProofs = result => ({...result, findings: result.findings.map(({proof, ...f}) => f), measures: result.measures.map(({proof, ...m}) => m)});

export function createAnalysisRoutes({memories, sessions, readBody, json, maxBytes = 1_000_000}) {
  // The `analysis` mode of ChatSOPAdapter, for the chat and the API that answer through the adapter.
  registerAnalysisMode().catch(() => null);
  const sourceOf = (kind, id, {user, admin}) => {
    if (kind === 'session') { sessions.visible(id, {user, admin}); return {sessions, id}; }
    memories.manifest(id);
    return {memories, id};
  };
  const analyze = kind => async ({req, res, match, user, admin}) => {
    const o = checkAnalyzeBody(await readBody(req, maxBytes));
    const result = analyzeSession(sourceOf(kind, match[1], {user, admin}), o.procedures, {parameters: o.parameters, documents: o.documents, reasoning: o.reasoning, verify: o.verify});
    json(res, 200, o.proofs ? result : withoutProofs(result));
  };
  const list = kind => ({res, match, user, admin}) => { const {procedures, lint} = listProcedures(sourceOf(kind, match[1], {user, admin})); json(res, 200, {object: 'list', data: procedures, lint}); };
  const actions = {analysisSession: analyze('session'), analysisMemory: analyze('memory'), analysisProceduresSession: list('session'), analysisProceduresMemory: list('memory')};
  const routes = [
    ['POST', new RegExp(`^/v1/sessions/${ID}/analyze$`), 'analysisSession'],
    ['POST', new RegExp(`^/v1/memories/${ID}/analyze$`), 'analysisMemory'],
    ['GET', new RegExp(`^/v1/sessions/${ID}/analysis-procedures$`), 'analysisProceduresSession'],
    ['GET', new RegExp(`^/v1/memories/${ID}/analysis-procedures$`), 'analysisProceduresMemory'],
  ];
  return {actions, routes};
}
