/**
 * The `analysis` mode of ChatSOPAdapter (lib/adapter, its extension point `registerMode`; DS022 "Analysis procedures").
 * `registerAnalysisMode()` registers the mode (the server does at start, server/analysis.mjs); nothing in the adapter's own files
 * changes. The mode answers with an analysis instead of a formalization: the request's options carry what to analyse, `adapter.answer({message, mode: 'analysis', options: {analysis: {source, procedures?,
 * parameters?, documents?, reasoning?}}})`, where `source` is a session {sessions, id}, a base memory {memories, id} or {circuits}. The
 * message is not interpreted (no understanding in code); the procedures and their parameters are chosen by the caller.
 *
 * Fields of the answer packet: path `analysis`; answer.values the finding ids, answer.answers the findings and measures; answer.text the
 * rendered report (conversation-v1 line_* replies); proofs the oracle proof of every finding; packet the analysis packet; verification
 * `unverified` (one formalization of the document, the document layer; every row is an oracle derivation).
 */
import {analyzeSession} from './index.mjs';

export const ANALYSIS_MODE = 'analysis';

export async function analysisMode(ctx) {
  const t0 = performance.now();
  const spec = ctx.settings.analysis ?? {};
  if (!spec.source) throw Object.assign(new Error('mode analysis needs options.analysis.source: a session, a base memory or circuits'), {code: 'invalid_parameter', status: 400});
  const result = analyzeSession(spec.source, spec.procedures ?? null, {parameters: spec.parameters ?? {}, documents: spec.documents ?? null, reasoning: spec.reasoning ?? 'auto', verify: spec.verify ?? 'auto'});
  const chosen = {
    path: ANALYSIS_MODE, status: 'ok', values: result.findings.map(f => f.id),
    answers: [...result.findings.map(f => ({kind: 'finding', id: f.id, value: f.rule.id, severity: f.severity})), ...result.measures.map(m => ({kind: 'measure', id: m.id, value: Object.values(m.values).at(-1)}))],
    packets: [Object.assign(result, {answer_text: result.text})], circuits: [], proofs: result.findings.map(f => f.proof).filter(Boolean),
  };
  return {
    results: [chosen], chosen, turn: {text: result.text},
    verification: {status: 'unverified', paths: [ANALYSIS_MODE], alternatives: [], note: 'analysis: the document layer is one formalization; every finding and measure is an oracle derivation with its proof'},
    timings: {analysis: Math.round(performance.now() - t0)}, tiers: {},
  };
}

/**
 * Registers the mode once (idempotent). The adapter is imported when the mode is registered, so this module loads where the adapter is
 * absent (a checkout without lib/adapter); the promise then resolves to null.
 */
export async function registerAnalysisMode() {
  let adapter;
  try { adapter = await import('../adapter/index.mjs'); } catch { return null; }
  if (!adapter.modeNames().includes(ANALYSIS_MODE)) adapter.registerMode(ANALYSIS_MODE, analysisMode);
  return ANALYSIS_MODE;
}
