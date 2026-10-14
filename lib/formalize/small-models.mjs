/**
 * Client of the prompted JSON roles of Ploinky (owner decisions 2026-10-03): `structure` (the problem structure: labelled spans and
 * relations, POST /v1/structure) and `formalizer` (FOL per sentence, POST /v1/fol), each a tier with a role prompt (Ploinky
 * prompted roles; variants such as `structure-good`, `formalizer-micro` name other tiers under the same contract). Requests are tagged
 * with a purpose (and a run) like every model call; Ploinky caches the answers, so the same request gives the same extraction or the
 * same FOL candidates. Returns {ok, body, ms, cached} or {ok: false, reason}; never throws on a model failure.
 */
import {pworker} from '../pworker.mjs';

const call = (kind, body, {purpose = 'formalize', run = null, cache = null, priority = null, timeoutMs = 300_000, fetchImpl = null, url = null} = {}) =>
  pworker({purpose, run, cache, priority, fetchImpl, url}).role(body.model)[kind](body, {timeoutMs});

/** The structure role: {text, entities, relations?, threshold?} → extraction JSON (entities by label with spans, relations). */
export const extractStructure = (request, options) => call('structure', {model: 'structure', ...request}, options);

/** The formalizer role: {inputs: [sentence], candidates?, context?} → {results: [{input, candidates: [fol]}]}. */
export const formalizeFol = (request, options) => call('fol', {model: 'formalizer', ...request}, options);
