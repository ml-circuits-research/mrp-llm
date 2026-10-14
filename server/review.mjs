/**
 * The knowledge browser of the server (DS022 "Knowledge browser", DS009 "Browser pages"): the `/review` page and its read-only API.
 *
 *   GET /review                                        the page (signed in)
 *   GET /v1/knowledge/memories                         every base memory: layers, provenance summary, counts, ingestions
 *   GET /v1/knowledge/memories/{id}                    one memory: layers with flag statistics, provenance, ingestions, world-v1 mapping table
 *   GET /v1/knowledge/memories/{id}/items              ?layer=&type=&flag=&group=&q=&offset=&limit=  risk-sorted items with evidence and examples
 *   GET /v1/knowledge/search                           ?memory=|session=&q=&kind=&offset=&limit=  keyword search
 *   GET /v1/knowledge/entities/{id}                    ?memory=|session=  entity card: classes, facts in both directions with layer and source, rules
 *   GET /v1/knowledge/predicates/{id}                  ?memory=|session=  predicate card: roles, lexeme forms with evidence, sentences, facts, rules
 *   GET /v1/knowledge/rules/{id}                       ?memory=|session=  rule card: SOP, English, an example derivation
 *   GET /v1/knowledge/derive                           ?memory=|session=&entity=&predicate=  what the oracle derives about an entity, with proofs
 *
 * Every route is read only and needs the server's authentication (a signed-in browser session or a bearer token), like every other
 * product route: the server has one administrator identity and no read-only role, so every authenticated caller may browse. A session
 * target must be visible to the caller. There is no accept or reject endpoint (AGENTS.md direction 8).
 */
import {KnowledgeBrowser} from '../lib/review/index.mjs';
import {reviewPage} from './pages/review.mjs';
import {sendHtml} from './pages/layout.mjs';

export const KNOWLEDGE_ENDPOINTS = Object.freeze([
  {method: 'GET', path: '/v1/knowledge/memories', capability: 'knowledge.memories'},
  {method: 'GET', path: '/v1/knowledge/memories/{id}', capability: 'knowledge.memory'},
  {method: 'GET', path: '/v1/knowledge/memories/{id}/items', capability: 'knowledge.items', query: ['layer', 'type', 'flag', 'group', 'q', 'offset', 'limit']},
  {method: 'GET', path: '/v1/knowledge/search', capability: 'knowledge.search', query: ['memory', 'session', 'q', 'kind', 'offset', 'limit']},
  {method: 'GET', path: '/v1/knowledge/entities/{id}', capability: 'knowledge.entity', query: ['memory', 'session']},
  {method: 'GET', path: '/v1/knowledge/predicates/{id}', capability: 'knowledge.predicate', query: ['memory', 'session']},
  {method: 'GET', path: '/v1/knowledge/rules/{id}', capability: 'knowledge.rule', query: ['memory', 'session']},
  {method: 'GET', path: '/v1/knowledge/derive', capability: 'knowledge.derive', query: ['memory', 'session', 'entity', 'predicate']},
]);

const ID = '([a-z0-9][a-z0-9_-]{0,63})';
const SYMBOL = '([A-Za-z0-9_][A-Za-z0-9_.:-]{0,199})';
const ROUTES = [
  [/^\/v1\/knowledge\/memories$/, 'memories'],
  [new RegExp(`^/v1/knowledge/memories/${ID}$`), 'memory'],
  [new RegExp(`^/v1/knowledge/memories/${ID}/items$`), 'items'],
  [/^\/v1\/knowledge\/search$/, 'search'],
  [new RegExp(`^/v1/knowledge/entities/${SYMBOL}$`), 'entity'],
  [new RegExp(`^/v1/knowledge/predicates/${SYMBOL}$`), 'predicate'],
  [new RegExp(`^/v1/knowledge/rules/${SYMBOL}$`), 'rule'],
  [/^\/v1\/knowledge\/derive$/, 'derive'],
];
const bad = (message, code = 'invalid_parameter', status = 400) => Object.assign(new Error(message), {status, code});
const int = (value, fallback, max) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw bad(`Expected an integer from 0 to ${max}, got ${JSON.stringify(String(value).slice(0, 20))}`);
  return n;
};

export function createKnowledgeRouter({memories = null, sessions = null, json, browser = memories ? new KnowledgeBrowser({memories, sessions}) : null}) {
  const target = (query, who) => browser.target({memory: query.memory || null, session: query.session || null}, who);
  const actions = {
    memories: () => ({object: 'list', data: browser.listMemories()}),
    memory: ({match}) => ({object: 'knowledge.memory', ...browser.memoryView(match[1])}),
    items: ({match, query}) => {
      const t = browser.target({memory: match[1]});
      const layer = query.layer || t.layers.at(-1).id;
      return {object: 'knowledge.items', ...browser.itemPage(t, layer, {type: query.type || null, flag: query.flag || null, group: query.group || null, q: query.q || null, offset: int(query.offset, 0, 1e7), limit: int(query.limit, 25, 200)})};
    },
    search: ({query, who}) => {
      if (typeof query.q !== 'string' || !query.q.trim()) throw bad('Provide q: the keywords');
      const kind = query.kind || null;
      if (kind && !['entities', 'classes', 'predicates', 'rules', 'facts'].includes(kind)) throw bad('kind must be entities, classes, predicates, rules or facts');
      return {object: 'knowledge.search', ...browser.search(target(query, who), query.q, {kind, offset: int(query.offset, 0, 1e6), limit: int(query.limit, 10, 100)})};
    },
    entity: ({match, query, who}) => ({object: 'knowledge.entity', ...browser.entity(target(query, who), match[1])}),
    predicate: ({match, query, who}) => ({object: 'knowledge.predicate', ...browser.predicate(target(query, who), match[1])}),
    rule: ({match, query, who}) => ({object: 'knowledge.rule', ...browser.rule(target(query, who), match[1])}),
    derive: ({query, who}) => {
      if (typeof query.entity !== 'string' || !query.entity) throw bad('Provide entity: the entity id');
      return {object: 'knowledge.derive', ...browser.derive(target(query, who), query.entity, {predicate: query.predicate || null})};
    },
  };

  /** True when the request was a knowledge-browser route (answered). */
  async function handle(req, res, url, query, {user = null, admin = false} = {}) {
    if (url === '/review') {
      if (req.method !== 'GET') return json(res, 405, {error: {message: 'Method not allowed', type: 'invalid_request_error', code: 'method_not_allowed'}}), true;
      sendHtml(res, 200, reviewPage({signedIn: admin}));
      return true;
    }
    for (const [pattern, action] of ROUTES) {
      const match = pattern.exec(url);
      if (!match) continue;
      if (req.method !== 'GET') { json(res, 405, {error: {message: 'The knowledge browser is read only: use GET', type: 'invalid_request_error', code: 'method_not_allowed'}}); return true; }
      try {
        if (!browser) throw bad('This server has no chat data root: there are no base memories to browse', 'not_available', 501);
        json(res, 200, actions[action]({match, query, who: {user, admin}}));
      } catch (e) {
        if (!res.destroyed) json(res, e.status ?? 400, {error: {message: e.message, type: 'invalid_request_error', code: e.code ?? 'invalid_request'}});
      }
      return true;
    }
    return false;
  }
  return {handle, browser};
}
