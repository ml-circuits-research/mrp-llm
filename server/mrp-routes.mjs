/**
 * HTTP routes of the MRP layer (DS025, DS027, docs/api.html "Models and strategies", "Model gateway settings").
 *
 *   GET    /v1/mrp/strategies[?check=1]                 slots and the strategy catalog (with availability on this server)
 *   GET    /v1/mrp/profiles                             ready-made model configurations
 *   GET    /v1/mrp/models                               the models
 *   POST   /v1/mrp/models                               {id, name?, description?, memories? | base?, createBase?, profile?, slots?, language?, faq?, allowOverrides?}
 *   GET    /v1/mrp/models/{id}                          a model with its learned state
 *   PUT    /v1/mrp/models/{id}                          {name?, description?, memories? | base?, slots?, language?, faq?, allowOverrides?}
 *   DELETE /v1/mrp/models/{id}
 *   GET    /v1/mrp/models/{id}/effective                the effective slot configuration (defaults filled in)
 *   POST   /v1/mrp/models/{id}/reflex-feedback          {score, helpful}: a vote on a reflex answer (faq-feedback learns from it)
 *   GET    /v1/mrp/models/{id}/review                   the review queue (commit strategy review-queue)
 *   POST   /v1/mrp/models/{id}/review/{item}/approve    write the queued circuits to the model's base memory
 *   POST   /v1/mrp/models/{id}/review/{item}/reject
 *
 *   GET    /v1/mrp/tiers                                the Ploinky tiers and the real models behind them (read only, every user)
 *
 * Model gateway settings (administrator only: the signed-in browser session): the Ploinky Workers home of this machine.
 *
 *   GET    /v1/mrp/pworker                              providers (key configured yes/no, never the key), tiers, proxy health
 *   PUT    /v1/mrp/pworker/providers/{name}/key         {key, validate?}: set (or with "" remove) a provider's API key
 *   POST   /v1/mrp/pworker/providers                    {name, endpoint, key?, rpm?}: add a custom OpenAI-compatible provider
 *   GET    /v1/mrp/pworker/providers/{name}/models      the provider's live model catalog
 *   PUT    /v1/mrp/pworker/tiers/{tier}                 {entries: [{provider, model, extraBody?}], batch?} or {alias}
 *   DELETE /v1/mrp/pworker/tiers/{tier}                 drop the user override of a tier
 *   POST   /v1/mrp/pworker/restart                      restart the proxy so it reads the changed keys and tiers
 */
import * as gateway from 'pworker/admin';
import {catalog} from '../lib/mrp/strategies.mjs';
import {profiles} from '../lib/mrp/models.mjs';
import {pworker} from '../lib/pworker.mjs';
import {compose} from '../lib/chat-data/composer.mjs';

const ID = '([a-z0-9][a-z0-9_-]{0,63})';
const bad = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {status, code});

export const MRP_ENDPOINTS = Object.freeze([
  {method: 'GET', path: '/v1/mrp/strategies', capability: 'mrp.strategies'},
  {method: 'GET', path: '/v1/mrp/profiles', capability: 'mrp.profiles'},
  {method: 'GET', path: '/v1/mrp/models', capability: 'mrp.models.list'},
  {method: 'POST', path: '/v1/mrp/models', capability: 'mrp.models.create', body: ['id', 'name', 'description', 'memories', 'base', 'createBase', 'profile', 'slots', 'language', 'faq', 'allowOverrides']},
  {method: 'GET', path: '/v1/mrp/models/{id}', capability: 'mrp.models.get'},
  {method: 'PUT', path: '/v1/mrp/models/{id}', capability: 'mrp.models.update', body: ['name', 'description', 'memories', 'base', 'slots', 'language', 'faq', 'allowOverrides']},
  {method: 'GET', path: '/v1/mrp/models/{id}/effective', capability: 'mrp.models.effective'},
  {method: 'GET', path: '/v1/mrp/models/{id}/review', capability: 'mrp.models.review'},
  {method: 'GET', path: '/v1/mrp/tiers', capability: 'mrp.tiers'},
  {method: 'GET', path: '/v1/mrp/pworker', capability: 'mrp.pworker'},
]);

/** Writes the circuits of a review item (or an auto-validated commit) into a model's base memory, with provenance. */
export function writeToBase({memories, model, circuits, approvedBy, reason, source}) {
  return memories.addKnowledge(model.base, {circuits, approvedBy, reason, source});
}

export function createMrpRoutes({models, memories, readBody, json, maxBytes = 2_000_000, admin: gatewayAdmin = gateway, env = process.env}) {
  const send = (res, status, body) => json(res, status, body);
  const body = async req => { const b = await readBody(req, maxBytes); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Expected a JSON object'); return b; };
  const requireAdmin = admin => { if (!admin) throw bad('The model gateway settings need the administrator session (sign in at /login)', 'forbidden', 403); };
  const withState = id => ({object: 'mrp.model', ...models.get(id), state: models.state(id)});

  async function gatewayView() {
    let health = null, proxy = null;
    try { proxy = await gatewayAdmin.proxyPid(env); } catch { proxy = null; }
    if (proxy) { try { health = await pworker({purpose: 'chat', autostart: false}).health(); } catch (e) { health = {error: e.message}; } }
    return {object: 'mrp.pworker', proxy: proxy ? {running: true, pid: proxy} : {running: false}, providers: gatewayAdmin.listProviders(env), ...gatewayAdmin.listTiers(env), served: health?.tiers ?? null, health_error: health?.error ?? null};
  }

  /**
   * Every tier with its configured chain (provider, model, thinking off) and what the running proxy serves now (the first usable entry
   * and the fallbacks); `served: null` when the proxy does not run.
   */
  async function tierView() {
    const {tiers} = gatewayAdmin.listTiers(env);
    let served = null;
    try { if (await gatewayAdmin.proxyPid(env)) served = Object.fromEntries(((await pworker({purpose: 'chat', autostart: false}).health()).tiers ?? []).map(t => [t.id, t.x_tier])); } catch { served = null; }
    return Object.entries(tiers).map(([tier, chain]) => ({
      tier,
      alias: typeof chain === 'string' ? chain : null,
      chain: Array.isArray(chain) ? chain.map(e => ({provider: e.upstream, model: e.model, thinking: e.extraBody?.thinking?.type === 'disabled' || e.extraBody?.chat_template_kwargs?.enable_thinking === false ? 'off' : null, reasoning_effort: e.extraBody?.reasoning_effort ?? null, minTokens: e.minTokens ?? null})) : [],
      serves: served?.[tier]?.serves ?? null, fallback: served?.[tier]?.fallback ?? [], error: served?.[tier]?.error ?? (served ? null : 'the Ploinky proxy is not running'),
    }));
  }

  /**
   * The knowledge of a Symbolic Model is one or several base memories (`memories`). One memory is used directly; several are composed
   * into the memory `sm-<model id>`, which imports them all and is rebuilt when the list changes (lib/chat-data/composer.mjs). Returns
   * the fields with `base` set accordingly.
   */
  function withMemories(id, fields, previous = null) {
    if (fields.memories === undefined) return fields;
    const list = fields.memories;
    if (!Array.isArray(list) || !list.length || list.some(m => typeof m !== 'string')) throw bad('memories must be a non-empty list of base memory ids', 'invalid_parameter');
    const composedId = `sm-${id}`;
    if (list.includes(composedId)) throw bad(`${composedId} is the composed memory of this Symbolic Model; choose its layers instead`, 'invalid_parameter');
    if (list.length === 1) return {...fields, base: list[0]};
    const same = previous && previous.base === composedId && JSON.stringify(previous.memories ?? []) === JSON.stringify(list) && models.memoryExists(composedId);
    if (!same) compose(memories, {id: composedId, name: `${fields.name ?? previous?.name ?? id} (knowledge)`, layers: list, description: `The knowledge of the Symbolic Model ${id}, composed from ${list.join(', ')}.`});
    return {...fields, base: composedId};
  }

  const routes = [
    ['GET', /^\/v1\/mrp\/strategies$/, async ({res, url}) => send(res, 200, {object: 'list', data: await catalog({check: url.searchParams.get('check') === '1'})})],
    ['GET', /^\/v1\/mrp\/profiles$/, ({res}) => send(res, 200, {object: 'list', data: profiles()})],
    ['GET', /^\/v1\/mrp\/models$/, ({res}) => send(res, 200, {object: 'list', data: models.list()})],
    ['POST', /^\/v1\/mrp\/models$/, async ({req, res, user}) => {
      const {createBase, ...fields} = await body(req);
      // createBase: a new, minimal base memory (imports core-min) named by `base`, on the engine of the model's memory slot (DS025 "Memory").
      if (createBase) {
        if (!fields.base || models.memoryExists(fields.base)) throw bad('createBase needs the id of a base memory that does not exist yet in base', 'invalid_parameter');
        const engine = fields.slots?.memory?.strategy ?? (typeof fields.slots?.memory === 'string' ? fields.slots.memory : 'sqlite');
        memories.create({id: fields.base, name: fields.name ?? fields.base, strategy: engine, imports: ['core-min'], description: `Base memory of the model ${fields.id}`});
      }
      send(res, 201, {object: 'mrp.model', ...models.create(createBase ? {...fields, memories: [fields.base]} : withMemories(String(fields.id ?? ''), fields)), ...(createBase ? {created_base: fields.base} : {})});
    }],
    ['GET', new RegExp(`^/v1/mrp/models/${ID}$`), ({res, m}) => send(res, 200, withState(m[1]))],
    ['PUT', new RegExp(`^/v1/mrp/models/${ID}$`), async ({req, res, m}) => send(res, 200, {object: 'mrp.model', ...models.update(m[1], withMemories(m[1], await body(req), models.get(m[1])))})],
    ['DELETE', new RegExp(`^/v1/mrp/models/${ID}$`), ({res, m}) => send(res, 200, {object: 'mrp.model.deleted', id: m[1], deleted: models.delete(m[1])})],
    ['GET', new RegExp(`^/v1/mrp/models/${ID}/effective$`), ({res, m}) => { const e = models.effective(m[1]); send(res, 200, {object: 'mrp.model.effective', id: m[1], slots: e.slots, language: e.language}); }],
    ['POST', new RegExp(`^/v1/mrp/models/${ID}/reflex-feedback$`), async ({req, res, m}) => {
      const b = await body(req);
      if (typeof b.helpful !== 'boolean' || (b.score != null && typeof b.score !== 'number')) throw bad('expected {score, helpful}', 'invalid_parameter');
      send(res, 200, {object: 'mrp.model.state', id: m[1], state: models.reflexFeedback(m[1], b)});
    }],
    ['GET', new RegExp(`^/v1/mrp/models/${ID}/review$`), ({res, m}) => send(res, 200, {object: 'list', data: models.state(m[1]).review ?? []})],
    ['POST', new RegExp(`^/v1/mrp/models/${ID}/review/([0-9a-f-]{36})/(approve|reject)$`), ({res, m, user}) => {
      const model = models.get(m[1]), item = models.reviewItem(m[1], m[2]);
      if (item.status !== 'pending') throw bad(`the review item is already ${item.status}`, 'invalid_state', 409);
      if (m[3] === 'reject') return send(res, 200, {object: 'mrp.review', ...models.setReviewStatus(m[1], m[2], 'rejected', {by: user}).review.find(r => r.id === m[2])});
      const written = writeToBase({memories, model, circuits: item.circuits, approvedBy: user, reason: `review queue of model ${model.id} (session ${item.session})`, source: `session:${item.session}`});
      send(res, 200, {object: 'mrp.review', ...models.setReviewStatus(m[1], m[2], 'approved', {by: user, written: written?.added?.length ?? 0}).review.find(r => r.id === m[2])});
    }],
    // The Ploinky tiers and the real models behind them, read only, for every authenticated user (no key, no provider secret).
    ['GET', /^\/v1\/mrp\/tiers$/, async ({res}) => send(res, 200, {object: 'list', data: await tierView()})],
    // ---- model gateway (Ploinky Workers home), administrator only
    ['GET', /^\/v1\/mrp\/pworker$/, async ({res, admin}) => { requireAdmin(admin); send(res, 200, await gatewayView()); }],
    ['PUT', /^\/v1\/mrp\/pworker\/providers\/([a-z][a-z0-9_-]*)\/key$/, async ({req, res, m, admin}) => {
      requireAdmin(admin);
      const b = await body(req);
      if (typeof b.key !== 'string' || b.key.length > 4096 || /[\s]/.test(b.key)) throw bad('key must be a string without spaces ("" removes it)', 'invalid_parameter');
      const r = await gatewayAdmin.setProviderKey(m[1], b.key, {validate: b.validate !== false, env});
      send(res, 200, {object: 'mrp.pworker.provider', ...r, restart_needed: true});
    }],
    ['POST', /^\/v1\/mrp\/pworker\/providers$/, async ({req, res, admin}) => {
      requireAdmin(admin);
      const b = await body(req);
      const r = await gatewayAdmin.saveCustomProvider(String(b.name ?? ''), {endpoint: b.endpoint, key: b.key ?? '', rpm: b.rpm ?? 60, validate: b.validate !== false, env});
      send(res, 201, {object: 'mrp.pworker.provider', ...r, restart_needed: true});
    }],
    ['GET', /^\/v1\/mrp\/pworker\/providers\/([a-z][a-z0-9_-]*)\/models$/, async ({res, m, admin}) => { requireAdmin(admin); send(res, 200, {object: 'list', provider: m[1], data: await gatewayAdmin.providerCatalog(m[1], {env})}); }],
    ['PUT', /^\/v1\/mrp\/pworker\/tiers\/([A-Za-z][\w-]{0,39})$/, async ({req, res, m, admin}) => {
      requireAdmin(admin);
      const b = await body(req);
      const r = await gatewayAdmin.setTierChain(m[1], b.alias ?? b.entries, {batch: b.batch, validate: b.validate === true, env});
      send(res, 200, {object: 'mrp.pworker.tier', ...r, restart_needed: true});
    }],
    ['DELETE', /^\/v1\/mrp\/pworker\/tiers\/([A-Za-z][\w-]{0,39})$/, ({res, m, admin}) => { requireAdmin(admin); send(res, 200, {object: 'mrp.pworker.tier', tier: m[1], removed: gatewayAdmin.removeTier(m[1], {env}), restart_needed: true}); }],
    ['POST', /^\/v1\/mrp\/pworker\/restart$/, async ({res, admin}) => { requireAdmin(admin); await gatewayAdmin.restartProxy({env, always: true}); send(res, 200, await gatewayView()); }],
  ];

  /** Handles a /v1/mrp/* request; false when no route matches. */
  async function handle(req, res, path, {admin = false, user = null} = {}) {
    if (!path.startsWith('/v1/mrp/')) return false;
    const url = new URL(req.url, 'http://localhost');
    for (const [method, pattern, fn] of routes) {
      const m = pattern.exec(path);
      if (!m || method !== req.method) continue;
      try { await fn({req, res, m, url, admin, user}); }
      catch (e) { if (!res.headersSent) send(res, e.status ?? 400, {error: {message: e.message + (e.problems?.length ? ': ' + e.problems.slice(0, 3).map(p => `${p.code}${p.wire ? ' @' + p.wire : ''}: ${p.message}`).join('; ') : ''), type: 'invalid_request_error', code: e.code ?? 'invalid_request', ...(e.problems ? {problems: e.problems.slice(0, 20)} : {})}}); }
      return true;
    }
    send(res, 404, {error: {message: `${req.method} ${path}`, type: 'invalid_request_error', code: 'not_found'}});
    return true;
  }
  return {handle};
}
