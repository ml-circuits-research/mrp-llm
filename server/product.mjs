/**
 * HTTP routes of the product layer (DS022, docs/api.html): base memories, sessions and the authoring path.
 *
 *   GET  /v1/memories                       list the base memories
 *   POST /v1/memories                       create an empty one, or import one: {name, strategy, circuits?, description?}
 *   GET  /v1/memories/{id}                  the manifest, the circuit names, the provenance and (?facts=1) the stored facts
 *   DELETE /v1/memories/{id}
 *   POST /v1/memories/{id}/fork             {name, strategy?, description?}
 *   POST /v1/memories/{id}/knowledge        {circuits: [{name, text}], reason?, source?}, validated, recorded with provenance
 *   GET  /v1/memory-composer                the layers a base memory can be composed from, the chat's reply memory and default base
 *   POST /v1/memory-composer                {id, layers, name?, description?}: build or refresh a base memory from chosen layers
 *
 *   POST /v1/sessions                       start a session on a base memory: {base, name?, settings?}
 *   GET  /v1/sessions                       the caller's sessions (all of them for the signed-in browser session)
 *   GET  /v1/sessions/{id}                  the session, its circuits and provenance (?transcript=1 adds the turns)
 *   DELETE /v1/sessions/{id}
 *   POST /v1/sessions/{id}/settings         {formalizer_model?, formalizer?, adapter_mode?}: the first tier of the step-by-step ladder; the formalization strategy; the ChatSOPAdapter mode
 *   POST /v1/sessions/{id}/commit           commit the accepted session circuits to a new fork: {name, strategy?, description?}
 *   GET  /v1/sessions/{id}/theory           the base circuits followed by the accepted session circuits
 *   POST /v1/sessions/{id}/query            {query}: run a query circuit over the session's memory: the oracle gets the slice the query needs (answer.retrieval)
 *
 * Every route needs the server's authentication (bearer token or administrator session) before it is reached; every
 * authenticated caller may create, fork, extend and delete base memories and commit sessions (owner decision of 2026-10-01: no
 * administrator role, provenance records the acting user). A session is visible to the user who started it and to a signed-in browser session. A bad request
 * answers 4xx with the standard `{error: {message, type, code}}`; a circuit that fails the knowledge validator answers 422 with
 * `problems` and `warnings` and writes nothing.
 */
import {STRATEGIES, ENCYCLOPEDIC_BASE} from '../lib/chat-data/memories.mjs';

/** The kinds of a new base memory: built on the encyclopedic default, on the minimal core, or on nothing. */
export const MEMORY_KINDS = Object.freeze(['encyclopedic', 'minimal', 'empty']);
import {strategyRequest} from './status.mjs';
import {parserFormalizer} from '../lib/adapter/modes/stepwise.mjs';
import {CORE_SEED} from '../lib/knowledge-seeds.mjs';
import {askMemory, TheoryCache} from '../reasoning/slice/index.mjs';
import {composableLayers, compose} from '../lib/chat-data/composer.mjs';

const bad = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {status, code});

/** Listed by GET /v1/capabilities next to the capability endpoints; the routes themselves are matched in this file. */
export const PRODUCT_ENDPOINTS = Object.freeze([
  {method: 'GET', path: '/v1/memories', capability: 'memories.list'},
  {method: 'POST', path: '/v1/memories', capability: 'memories.create', body: ['name', 'strategy', 'description', 'circuits', 'reason', 'source', 'id', 'imports', 'kind']},
  {method: 'GET', path: '/v1/memories/{id}', capability: 'memories.get'},
  {method: 'POST', path: '/v1/memories/{id}/fork', capability: 'memories.fork', body: ['name', 'strategy', 'description', 'id']},
  {method: 'POST', path: '/v1/memories/{id}/knowledge', capability: 'memories.knowledge', body: ['circuits', 'reason', 'source']},
  {method: 'GET', path: '/v1/memory-composer', capability: 'memories.composer'},
  {method: 'POST', path: '/v1/memory-composer', capability: 'memories.compose', body: ['id', 'layers', 'name', 'description']},
  {method: 'POST', path: '/v1/sessions', capability: 'sessions.create', body: ['base', 'name', 'settings']},
  {method: 'GET', path: '/v1/sessions', capability: 'sessions.list'},
  {method: 'GET', path: '/v1/sessions/{id}', capability: 'sessions.get'},
  {method: 'POST', path: '/v1/sessions/{id}/settings', capability: 'sessions.settings', body: ['formalizer_model', 'formalizer', 'adapter_mode', 'model', 'language', 'slots']},
  {method: 'POST', path: '/v1/sessions/{id}/commit', capability: 'sessions.commit', body: ['name', 'strategy', 'description', 'id']},
  {method: 'GET', path: '/v1/sessions/{id}/theory', capability: 'sessions.theory'},
  {method: 'POST', path: '/v1/sessions/{id}/query', capability: 'sessions.query', body: ['query', 'message', 'reasoning', 'verify']},
]);

const STRATEGY_NOTES = {
  sqlite: 'SQLite (DS018): exact indexed tuples',
};
const memoryStrategies = () => STRATEGIES.map(id => ({id, note: STRATEGY_NOTES[id] ?? ''}));

const ID = '([a-z0-9][a-z0-9_-]{0,63})';
const ROUTES = [
  ['GET', /^\/v1\/memories$/, 'memoriesList'],
  ['POST', /^\/v1\/memories$/, 'memoriesCreate'],
  ['GET', new RegExp(`^/v1/memories/${ID}$`), 'memoriesGet'],
  ['DELETE', new RegExp(`^/v1/memories/${ID}$`), 'memoriesDelete'],
  ['POST', new RegExp(`^/v1/memories/${ID}/fork$`), 'memoriesFork'],
  ['POST', new RegExp(`^/v1/memories/${ID}/knowledge$`), 'memoriesKnowledge'],
  ['GET', /^\/v1\/memory-composer$/, 'composerList'],
  ['POST', /^\/v1\/memory-composer$/, 'composerBuild'],
  ['POST', /^\/v1\/sessions$/, 'sessionsCreate'],
  ['GET', /^\/v1\/sessions$/, 'sessionsList'],
  ['GET', new RegExp(`^/v1/sessions/${ID}$`), 'sessionsGet'],
  ['DELETE', new RegExp(`^/v1/sessions/${ID}$`), 'sessionsDelete'],
  ['POST', new RegExp(`^/v1/sessions/${ID}/settings$`), 'sessionsSettings'],
  ['POST', new RegExp(`^/v1/sessions/${ID}/commit$`), 'sessionsCommit'],
  ['GET', new RegExp(`^/v1/sessions/${ID}/theory$`), 'sessionsTheory'],
  ['POST', new RegExp(`^/v1/sessions/${ID}/query$`), 'sessionsQuery'],
];

function sendError(res, e, json) {
  const status = e.status ?? 400;
  const body = {error: {message: e.message, type: 'invalid_request_error', code: e.code ?? 'invalid_request', ...(e.problems ? {problems: e.problems, warnings: e.warnings ?? []} : {})}};
  if (!res.destroyed) json(res, status, body);
}

const onlyKeys = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Expected a JSON object');
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw bad(`Unsupported parameter ${JSON.stringify(extra[0])}; accepted: ${allowed.join(', ') || 'none'}`, 'unsupported_parameter');
  return body;
};

/**
 * `composer` (optional): `{replyMemory: () => id, onComposed: manifest => info}`; the server reloads the chat's reply layer when the
 * reply memory is rebuilt and reports it in the answer.
 */
export function createProductRouter({memories, sessions, runtimes, readBody, json, limits = {}, extra = {}, parsing = null, defaultBase = runtimes?.defaultBase ?? 'default', composer = {}, modelBaseOf = null, commitGuard = null, checkMrpSettings = null}) {
  const maxBytes = limits.maxProductBytes ?? 8_000_000;
  const theories = new TheoryCache();

  const actions = {
    memoriesList: ({res}) => json(res, 200, {object: 'list', data: memories.list().map(m => memories.withStats(m)), strategies: memoryStrategies(), default_base: defaultBase, kinds: MEMORY_KINDS}),
    async memoriesCreate({req, res, approvedBy}) {
      const body = onlyKeys(await readBody(req, maxBytes), ['name', 'strategy', 'description', 'circuits', 'reason', 'source', 'id', 'imports', 'kind']);
      const {name, strategy, description, circuits, reason, source, id} = body;
      // Three kinds (DS022 "Base memories"): `encyclopedic` (a copy-on-write fork of the encyclopedic default, the knowledge of world-v1),
      // `minimal` (imports core-min, the default kind) and `empty` (no imports). `imports` names the layers explicitly instead.
      if (body.kind !== undefined && !MEMORY_KINDS.includes(body.kind)) throw bad(`kind must be one of ${MEMORY_KINDS.join(', ')}`, 'invalid_parameter');
      if (body.kind !== undefined && body.imports !== undefined) throw bad('Give either kind or imports, not both', 'invalid_parameter');
      if (body.kind === 'encyclopedic') {
        if (defaultBase !== ENCYCLOPEDIC_BASE) throw bad(`The encyclopedic base memory ${ENCYCLOPEDIC_BASE} is not loaded on this server`, 'not_available', 409);
        const forked = memories.fork(ENCYCLOPEDIC_BASE, {name, strategy, description, newId: id});
        const added = circuits?.length ? memories.addKnowledge(forked.memory.id, {circuits, approvedBy, reason: reason ?? 'import', source: source ?? null}) : null;
        return json(res, 201, {object: 'memory', ...memories.describe(forked.memory.id), kind: 'encyclopedic', ...(added ? {added: added.added} : {})});
      }
      const imports = body.kind === 'empty' ? [] : body.imports ?? [CORE_SEED];
      if (!Array.isArray(imports) || imports.some(x => typeof x !== 'string')) throw bad('imports must be an array of base memory ids', 'invalid_imports');
      const created = circuits?.length
        ? memories.importMemory({name, strategy, description, circuits, imports, approvedBy, reason, source, id})
        : memories.create({name, strategy, description, imports, id});
      json(res, 201, {object: 'memory', ...created});
    },
    memoriesGet({req, res, match}) {
      const withFacts = new URL(req.url, 'http://localhost').searchParams.get('facts');
      json(res, 200, {object: 'memory', ...memories.describe(match[1]), ...(withFacts ? {stored_facts: memories.facts(match[1])} : {})});
    },
    memoriesDelete({res, match}) { memories.delete(match[1]); json(res, 200, {object: 'memory.deleted', id: match[1], deleted: true}); },
    async memoriesFork({req, res, match}) {
      const body = onlyKeys(await readBody(req, maxBytes), ['name', 'strategy', 'description', 'id']);
      json(res, 201, {object: 'memory.fork', ...memories.fork(match[1], {name: body.name, strategy: body.strategy, description: body.description, newId: body.id})});
    },
    async memoriesKnowledge({req, res, match, approvedBy}) {
      const body = onlyKeys(await readBody(req, maxBytes), ['circuits', 'reason', 'source']);
      json(res, 200, {object: 'memory.knowledge', ...memories.addKnowledge(match[1], {circuits: body.circuits, approvedBy, reason: body.reason ?? '', source: body.source ?? null})});
    },

    // The base-memory composer (DS022 "Composing a base memory"): every authenticated user may compose, like creating a memory.
    composerList: ({res}) => json(res, 200, {object: 'memory.composer', layers: composableLayers(memories), reply_memory: composer.replyMemory?.() ?? null, default_base: defaultBase}),
    async composerBuild({req, res}) {
      const body = onlyKeys(await readBody(req, maxBytes), ['id', 'layers', 'name', 'description']);
      // Sessions are clones of their base: a rebuilt memory reaches the sessions started after it.
      const done = compose(memories, {id: body.id, name: body.name, description: body.description, layers: body.layers});
      const after = composer.onComposed?.(done.memory) ?? null;
      json(res, 201, {object: 'memory.composed', ...done.memory, replaced: done.replaced, validated: done.validated, ms: done.ms, ...(after ? {reply_layer: after} : {})});
    },

    async sessionsCreate({req, res, user, admin}) {
      const body = onlyKeys(await readBody(req, maxBytes), ['base', 'name', 'settings', 'id']);
      // A session is a fork of a base memory; without `base` it forks the default (the encyclopedic world-v1 when loaded).
      if (body.base !== undefined && typeof body.base !== 'string') throw bad('base must be the id of a base memory (GET /v1/memories)', 'invalid_parameter');
      // A session of an MRP model (settings.model) starts on the model's base memory unless a base is named.
      // MRP settings (model, slots) are checked now, so a bad value is refused here and not at every later turn.
      if (body.settings) checkMrpSettings?.(body.settings);
      const modelBase = body.settings?.model && modelBaseOf ? modelBaseOf(body.settings.model) : null;
      const info = sessions.create({base: body.base ?? modelBase ?? defaultBase, user, name: body.name, settings: body.settings, id: body.id});
      json(res, 201, {object: 'session', ...sessions.describe(info.id), admin});
    },
    sessionsList: ({res, user, admin}) => json(res, 200, {object: 'list', data: sessions.list({user, admin})}),
    sessionsGet({req, res, match, user, admin}) {
      sessions.visible(match[1], {user, admin});
      const withTranscript = new URL(req.url, 'http://localhost').searchParams.get('transcript');
      json(res, 200, {object: 'session', ...sessions.describe(match[1]), ...(withTranscript ? {transcript: sessions.transcript(match[1])} : {})});
    },
    sessionsDelete({res, match, user, admin}) {
      sessions.visible(match[1], {user, admin});
      runtimes?.close(match[1]);
      sessions.delete(match[1]);
      json(res, 200, {object: 'session.deleted', id: match[1], deleted: true});
    },
    async sessionsSettings({req, res, match, user, admin}) {
      sessions.visible(match[1], {user, admin});
      const body = onlyKeys(await readBody(req, maxBytes), ['formalizer_model', 'formalizer', 'omp_model', 'adapter_mode', 'model', 'language', 'slots']);
      checkMrpSettings?.(body);
      json(res, 200, {object: 'session', ...sessions.describe(sessions.updateSettings(match[1], body).id)});
    },
    async sessionsCommit({req, res, match, approvedBy, user, admin}) {
      const info = sessions.visible(match[1], {user, admin});
      // The model's commit policy may refuse explicit commits (commit strategy never, DS025).
      commitGuard?.(info);
      const body = onlyKeys(await readBody(req, maxBytes), ['name', 'strategy', 'description', 'id']);
      json(res, 201, {object: 'session.commit', ...sessions.commit(match[1], {name: body.name, strategy: body.strategy, description: body.description, newId: body.id, approvedBy})});
    },
    sessionsTheory({res, match, user, admin}) {
      sessions.visible(match[1], {user, admin});
      json(res, 200, {object: 'session.theory', theory: sessions.theory(match[1]), base: sessions.info(match[1]).base, session_circuits: sessions.circuits(match[1]).map(c => c.name)});
    },
    async sessionsQuery({req, res, match, user, admin}) {
      sessions.visible(match[1], {user, admin});
      const body = onlyKeys(await readBody(req, maxBytes), ['query', 'message', 'reasoning', 'verify']);
      // `message`: a natural-language request instead of a query circuit. The request parser (the formalizer, server/query-parser.mjs) writes the query,
      // and the shared chat path links, retrieves, routes, verifies and renders it (DS009 "Request parser").
      if (body.message !== undefined) {
        if (body.query !== undefined) throw bad('Give either query (a circuit) or message (a request), not both', 'invalid_parameter');
        if (typeof body.message !== 'string' || !body.message.trim()) throw bad('message must be a non-empty string', 'invalid_parameter');
        if (!parsing?.queryParser || !runtimes) throw bad('Requests in natural language need the server with chat sessions', 'not_available', 501);
        const rt = runtimes.open(match[1], {user, admin});
        const lexicon = rt.lexicon;
        // The circuit author of the chat (ChatSOPAdapter's parserFormalizer, lib/adapter): the request parser with the session's settings.
        const formalizer = parserFormalizer(parsing.queryParser, {lexicon, source: 'chat', preferredModel: rt.info?.settings?.formalizer_model ?? rt.info?.settings?.omp_model ?? null, request: strategyRequest(parsing.queryParser, rt.info?.settings?.formalizer)});
        const turn = await rt.entry(user).agent.turn(body.message, {formalizer}).catch(e => { e.parse = e.parse ?? formalizer.parse; throw e; });
        rt.save(rt.entry(user), user);
        const parseRecord = formalizer.parse;
        if (turn.packet) turn.packet.parse = parseRecord;
        return json(res, 200, {object: 'session.query', session: match[1], parse: parseRecord, model_sop: turn.sop, circuit: turn.executionSop, text: turn.text, answer: turn.packet});
      }
      if (typeof body.query !== 'string' || !body.query.trim()) throw bad('Provide query: a query circuit text', 'invalid_parameter');
      // The query is answered from a slice of the session's memory: the rules that can reach it and the facts they and the query can use,
      // never the whole theory (reasoning/slice/wire.mjs). Without chat sessions (an embedded server) the whole theory goes to the oracle.
      if (!runtimes) {
        const {ask} = await import('../reasoning/strategies/js-reference/index.mjs');
        return json(res, 200, {object: 'session.query', session: match[1], answer: await ask({theory: {knowledge: sessions.theory(match[1])}, query: body.query}, {})});
      }
      const theory = theories.get([...sessions.baseCircuits(match[1]), ...sessions.circuits(match[1])]);
      const rt = runtimes.open(match[1], {user, admin});
      // `reasoning`: auto (default; the StrategyRouter chooses and reports `route`) or one strategy id, run exactly (AGENTS.md rule 8); `verify`: auto|always|never
      for (const [k, allowed] of [['reasoning', null], ['verify', ['auto', 'always', 'never']]]) if (body[k] !== undefined && (typeof body[k] !== 'string' || (allowed && !allowed.includes(body[k])))) throw bad(`${k} must be ${allowed ? allowed.join(', ') : 'a strategy id or auto'}`, 'invalid_parameter');
      const answer = askMemory({theory, repo: rt.repo, session: rt.entry(user).agent.session, query: body.query, reasoning: body.reasoning ?? 'auto', verify: body.verify ?? 'auto'});
      json(res, 200, {object: 'session.query', session: match[1], answer});
    },
    ...extra.actions,
  };
  const routes = [...ROUTES, ...(extra.routes ?? [])];

  /** True when the request was a product route (answered). `admin`: the administrator session; `user`: the authenticated user. */
  async function handle(req, res, url, {admin = false, user = null} = {}) {
    for (const [method, pattern, action] of routes) {
      const match = pattern.exec(url);
      if (!match) continue;
      if (req.method !== method) continue;
      try {
        const who = typeof user === 'string' && user ? user : 'admin';
        await actions[action]({req, res, match, user: who, admin, approvedBy: who});
      } catch (e) { sendError(res, e, json); }
      return true;
    }
    // A known path with another method answers 405; anything else is not a product route.
    if (routes.some(([, pattern]) => pattern.test(url))) { sendError(res, bad('Method not allowed for this endpoint', 'method_not_allowed', 405), json); return true; }
    return false;
  }
  return {handle};
}
