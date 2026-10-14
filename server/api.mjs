/**
 * HTTP routes of the service facts (DS009 "Capabilities and caches", docs/api.html).
 *
 *   GET  /v1/capabilities   the endpoint list and the component versions
 *   GET  /v1/cache/stats    the statistics of the request parser's cache
 *   POST /v1/cache/clear    empties it
 *
 * Authentication is the server's own (bearer token or administrator session), checked before a route is reached. 4xx/5xx carry the
 * standard `{error: {message, type, code}}`.
 */
export const API_ENDPOINTS = Object.freeze([
  {method: 'GET', path: '/v1/capabilities', capability: 'capabilities'},
  {method: 'GET', path: '/v1/cache/stats', capability: 'cache.stats'},
  {method: 'POST', path: '/v1/cache/clear', capability: 'cache.clear', body: []},
]);

export function createApiRouter({capabilities, json, extraEndpoints = []}) {
  const known = new Map(API_ENDPOINTS.map(e => [e.method + ' ' + e.path, e]));
  /** Returns true when the request was a capability route (handled, answer sent). */
  async function handle(req, res, url) {
    const endpoint = known.get(req.method + ' ' + url);
    if (!endpoint) return false;
    if (url === '/v1/capabilities') { json(res, 200, {object: 'capabilities', endpoints: [...API_ENDPOINTS, ...extraEndpoints].map(({admin: a, ...e}) => ({...e, ...(a ? {admin: true} : {})})), versions: capabilities.versions()}); return true; }
    if (url === '/v1/cache/stats') { json(res, 200, {object: 'cache.stats', caches: capabilities.cacheStats()}); return true; }
    req.resume();
    capabilities.clearCaches();
    json(res, 200, {object: 'cache.clear', cleared: true, caches: capabilities.cacheStats()});
    return true;
  }
  return {handle, endpoints: API_ENDPOINTS};
}
