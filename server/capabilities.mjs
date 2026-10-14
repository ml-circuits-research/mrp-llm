/**
 * The service facts of the server (DS009 "Capabilities and caches"): the versions of the components that produce an answer and the
 * statistics of the one cache that exists, the request parser's circuit cache (server/query-parser.mjs).
 *
 * Every component is named once here so that `GET /v1/capabilities` and the trace of a turn agree: the request parser (its step-by-step
 * strategy and the tier ladder that answers its questions), the reasoning router and the answer renderer.
 */
import {PARSER_NAMES} from '../lib/formalize/strategies.mjs';

export const API_VERSION = 'capability-api-v2';
export const RENDERER_VERSION = 'answer-text-v1';

export function createCapabilities({queryParser = null} = {}) {
  const chain = () => queryParser?.settings?.models ?? [];
  return {
    versions: () => ({
      api: API_VERSION,
      request_parser: {parser: PARSER_NAMES[queryParser?.settings?.strategy] ?? null, strategy: queryParser?.settings?.strategy ?? null, backend: 'completion', models: chain()},
      reasoning: {router: 'StrategyRouter v1', oracle: 'js-reference'},
      renderer: RENDERER_VERSION,
    }),
    cacheStats: () => (queryParser ? {'query-parser': {entries: queryParser.stats().cache_size, hits: queryParser.stats().cache_hits, requests: queryParser.stats().requests}} : {}),
    clearCaches: () => queryParser?.clearCache(),
    close: () => {},
  };
}
