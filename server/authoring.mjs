/**
 * The authoring path over HTTP (DS022): `POST /v1/author`, plus the status of a request. No path runs omp (owner 2026-10-02): every
 * model is called directly through the Ploinky proxy.
 *
 *   POST /v1/author                              {session?, files?: [{name, text}], instructions?, model?, wait?}
 *   GET  /v1/sessions/{id}/requests/{request}    the status, and when finished the result, of an authoring request
 *   POST /v1/memories/{id}/ingest                {documents: [{name, text, title?, source: {rights, url?, licence?}}], model?, purpose?, wait?}
 *   GET  /v1/memories/{id}/ingestions            the ingestions of a base memory
 *   GET  /v1/memories/{id}/ingestions/{ing}      one ingestion: chunks, extracted, rejected, held back, uncertain, and the report
 *   POST /v1/memories/{id}/procedures            {id, description, definitions}: a procedure bundle for the procedure library
 *
 * A request creates `chat_data/sessions/<id>/requests/<request>/` (or a folder under `chat_data/tmp/` without a session), calls a model
 * of the formalizer chain directly (lib/ingest/direct-author.mjs: one chat-completion conversation through the Ploinky proxy; no
 * omp, owner 2026-10-02), validates the circuits, repairs them for a bounded number of rounds and, with a session, adds the validated
 * circuits to that session's layer (no manual acceptance, owner 2026-10-02). `wait: false` answers 202 at once; the page then polls
 * the status route. The model is the request's `model`, else the session's `formalizer_model`, else the first model of the chain.
 *
 * Document ingestion (DS022 "Ingesting documents into a base memory", lib/ingest/) runs the same direct author chunk by chunk over a base
 * memory and stores every validated chunk with its provenance (no acceptance step). A procedure (DS022 "Procedure library") is knowledge like any
 * other: validated with the memory's layers and recorded with provenance.
 */
import fs from 'node:fs';
import path from 'node:path';
import {directAuthor, openaiChat} from '../lib/ingest/direct-author.mjs';
import {chainEntry, providerSettings} from '../lib/llm-providers.mjs';
import {Ingestions, checkDocuments} from '../lib/ingest/index.mjs';
import {procedureCircuit} from '../lib/query-author/procedures.mjs';

const bad = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {status, code});
const ID = '([a-z0-9][a-z0-9_-]{0,63})';

export const AUTHORING_ENDPOINTS = Object.freeze([
  {method: 'POST', path: '/v1/author', capability: 'author', body: ['session', 'files', 'instructions', 'model', 'wait']},
  {method: 'GET', path: '/v1/sessions/{id}/requests/{request}', capability: 'author.request'},
  {method: 'POST', path: '/v1/memories/{id}/ingest', capability: 'memories.ingest', body: ['documents', 'model', 'purpose', 'wait']},
  {method: 'GET', path: '/v1/memories/{id}/ingestions', capability: 'memories.ingestions'},
  {method: 'GET', path: '/v1/memories/{id}/ingestions/{ingestion}', capability: 'memories.ingestion'},
  {method: 'POST', path: '/v1/memories/{id}/procedures', capability: 'memories.procedures', body: ['id', 'description', 'definitions', 'reason']},
]);

export function createAuthoring({sessions, runtimes = null, chatData, settings = {}, formalizer = null, readBody, json, maxBytes = 8_000_000, chat = null}) {
  settings = {maxFixRounds: 3, maxConcurrent: 2, ...(formalizer ? {maxFixRounds: Math.max(formalizer.maxFixRounds ?? 2, 3), maxConcurrent: formalizer.maxConcurrent ?? 2} : {}), ...settings};
  const jobs = new Map();
  let running = 0;

  const publicPath = dir => path.relative(chatData.root, dir);

  /**
   * The model a knowledge authoring request uses: the request's, then the configured authoring tier (`settings.model`, from
   * `ingest.tier`), then the openference default. The session's `formalizer_model` names the first tier of the step-by-step questions
   * (owner decision 2026-10-02) and does not choose the knowledge author.
   */
  function chooseDirect(requested) {
    const providers = formalizer?.providers ?? providerSettings();
    const wanted = requested ?? settings.model ?? 'openference';
    let entry;
    try { entry = chainEntry(wanted, {providers}); } catch (error) { throw bad(`Model ${JSON.stringify(wanted)} is not a model of a configured provider: ${error.message}`, 'unknown_model'); }
    return {model: entry.id, entry, cost_class: entry.provider === 'openference' ? 'subscription' : 'paid_api'};
  }

  function setStatus(entry, patch) {
    Object.assign(entry.status, patch, {updated_at: new Date().toISOString()});
    try { fs.writeFileSync(path.join(entry.folder, 'status.json'), JSON.stringify(entry.status, null, 2) + '\n'); } catch { /* the folder may have been cleaned */ }
  }

  /** Runs one authoring request. Returns {request_id, promise}; the promise resolves to the result object. */
  async function start({session: sessionId = null, user, admin, files, instructions = '', model: requested = null}) {
    const info = sessionId ? sessions.visible(sessionId, {user, admin}) : null;
    const chosen = chooseDirect(requested);
    if (running >= settings.maxConcurrent) throw bad('The authoring model is busy; try again shortly', 'author_busy', 429);
    const request = info ? sessions.requestFolder(sessionId) : (() => { const dir = chatData.tmpFolder('req'); return {id: path.basename(dir), dir}; })();
    const entry = {id: request.id, folder: request.dir, session: sessionId, status: {request_id: request.id, session: sessionId, status: 'running', phase: 'queued', round: 0, model: chosen.model, cost_class: chosen.cost_class, started_at: new Date().toISOString()}};
    jobs.set(request.id, entry);
    running++;
    const existing = sessionId ? [...sessions.baseCircuits(sessionId), ...sessions.circuits(sessionId)] : [];
    const promise = (async () => {
      try {
        const result = await directAuthor({folder: request.dir, files, instructions, model: chosen.entry.model, existing, maxFixRounds: settings.maxFixRounds,
          chat: chat ?? openaiChat({upstream: chosen.entry.upstream, purpose: 'ingest'}), onProgress: p => setStatus(entry, {phase: p.phase, round: p.round})});
        let added = null, notAdded = null;
        if (sessionId && result.ok && result.circuits.length) {
          try { added = sessions.addCircuit(sessionId, {name: `authored-${request.id}`, text: result.circuits[0].text, request: request.id, model: chosen.model, origin: 'authoring'}); }
          catch (error) { notAdded = (error.problems ?? [{code: error.code, message: error.message}]).slice(0, 20); }
        }
        if (sessionId) sessions.appendTranscript(sessionId, {role: 'authoring', request: request.id, status: result.status, added: added?.file ?? null, model: chosen.model, cost_usd: result.usage.cost_usd});
        const out = {object: 'author.result', request_id: request.id, session: sessionId, status: result.status, ok: result.ok, rounds: result.rounds, model: chosen.model, cost_class: chosen.cost_class,
          added: added ? {file: added.file} : null, ...(notAdded ? {not_added: notAdded} : {}), circuits: result.circuits, queries: result.queries, report: result.report, validation: result.validation, usage: result.usage, duration_ms: result.duration_ms, runs: result.runs,
          folder: publicPath(request.dir), ...(result.reason ? {reason: result.reason} : {})};
        setStatus(entry, {status: result.status, phase: 'done', result: out});
        return out;
      } catch (error) {
        setStatus(entry, {status: 'failed', phase: 'done', error: error.message});
        throw error;
      } finally { running--; }
    })();
    promise.catch(() => {});
    return {request_id: request.id, promise};
  }

  const memories = sessions?.memories ?? null;
  const ingestions = memories ? new Ingestions({memories}) : null;
  const ingesting = new Set();

  const actions = {
    async ingest({req, res, match, user}) {
      const body = await readBody(req, maxBytes);
      const extra = Object.keys(body).filter(k => !['documents', 'model', 'purpose', 'wait', 'author'].includes(k));
      if (extra.length) throw bad(`Unsupported parameter ${JSON.stringify(extra[0])}; accepted: documents, model, purpose, wait, author`, 'unsupported_parameter');
      const author = body.author ?? 'direct';
      if (author !== 'direct') throw bad('author must be direct (chat completions through the Ploinky proxy); the omp author was retired', 'invalid_parameter');
      memories.manifest(match[1]);
      checkDocuments(body.documents);
      // The direct author (owner 2026-10-02) calls the proxy model chunk by chunk.
      const chosen = {model: typeof body.model === 'string' ? body.model : null};
      if (ingesting.has(match[1])) throw bad('An ingestion into this memory is already running', 'ingest_busy', 429);
      ingesting.add(match[1]);
      const promise = ingestions.draft(match[1], {documents: body.documents, model: chosen.model, purpose: typeof body.purpose === 'string' ? body.purpose.slice(0, 500) : '', user, author,
        maxFixRounds: settings.maxFixRounds, ...(settings.timeoutSeconds ? {timeoutMs: settings.timeoutSeconds * 1000} : {}), ...(chat ? {chat} : {})})
        .finally(() => { ingesting.delete(match[1]); });
      promise.catch(() => {});
      if (body.wait === false) {
        // The record exists as soon as drafting starts; answer with the list entry that appeared.
        await new Promise(r => setTimeout(r, 50));
        const latest = ingestions.list(match[1]).at(-1);
        return json(res, 202, {object: 'memory.ingestion', memory: match[1], ingestion: latest?.id ?? null, status: 'drafting', status_url: latest ? `/v1/memories/${match[1]}/ingestions/${latest.id}` : null});
      }
      const record = await promise;
      json(res, 200, {object: 'memory.ingestion', ...record, report: fs.readFileSync(path.join(ingestions.dir(match[1], record.id), 'report.md'), 'utf8')});
    },
    ingestionList({res, match}) { json(res, 200, {object: 'list', data: ingestions.list(match[1])}); },
    ingestionGet({res, match}) {
      const record = ingestions.get(match[1], match[2]);
      json(res, 200, {object: 'memory.ingestion', ...record, report: fs.readFileSync(path.join(ingestions.dir(match[1], match[2]), 'report.md'), 'utf8')});
    },
    async procedures({req, res, match, approvedBy}) {
      const body = await readBody(req, maxBytes);
      const extra = Object.keys(body).filter(k => !['id', 'description', 'definitions', 'reason'].includes(k));
      if (extra.length) throw bad(`Unsupported parameter ${JSON.stringify(extra[0])}; accepted: id, description, definitions, reason`, 'unsupported_parameter');
      if (typeof body.definitions !== 'string') throw bad('definitions must be SOP text (predicate, rule, default wires)', 'invalid_parameter');
      const text = procedureCircuit({id: body.id, description: body.description, definitions: body.definitions});
      const added = memories.addKnowledge(match[1], {circuits: [{name: `procedure-${body.id}`, text}], approvedBy, reason: body.reason ?? 'procedure library', source: {kind: 'procedure', id: body.id, description: body.description}});
      json(res, 200, {object: 'memory.procedure', procedure: body.id, ...added});
    },
    async author({req, res, user, admin}) {
      const body = await readBody(req, maxBytes);
      const extra = Object.keys(body).filter(k => !['session', 'files', 'instructions', 'model', 'wait'].includes(k));
      if (extra.length) throw bad(`Unsupported parameter ${JSON.stringify(extra[0])}; accepted: session, files, instructions, model, wait`, 'unsupported_parameter');
      if (body.session !== undefined && typeof body.session !== 'string') throw bad('session must be a session id', 'invalid_parameter');
      if (body.model !== undefined && typeof body.model !== 'string') throw bad('model must be a model selector', 'invalid_parameter');
      const {request_id: requestId, promise} = await start({session: body.session ?? null, user, admin, files: body.files ?? [], instructions: body.instructions ?? '', model: body.model ?? null});
      if (body.wait === false) return json(res, 202, {object: 'author.request', request_id: requestId, session: body.session ?? null, status: 'running', status_url: body.session ? `/v1/sessions/${body.session}/requests/${requestId}` : null});
      const result = await promise;
      json(res, 200, result);
    },
    requestStatus({res, match, user, admin}) {
      const [, id, requestId] = match;
      sessions.visible(id, {user, admin});
      const live = jobs.get(requestId);
      if (live && live.session === id) return json(res, 200, {object: 'author.status', ...live.status});
      const file = path.join(sessions.dir(id), 'requests', requestId, 'status.json');
      if (!fs.existsSync(file)) throw bad(`Unknown request ${JSON.stringify(requestId)}`, 'unknown_request', 404);
      json(res, 200, {object: 'author.status', ...JSON.parse(fs.readFileSync(file, 'utf8'))});
    },
  };
  const routes = [
    ['POST', /^\/v1\/author$/, 'author'],
    ['GET', new RegExp(`^/v1/sessions/${ID}/requests/${ID}$`), 'requestStatus'],
    ...(ingestions ? [
      ['POST', new RegExp(`^/v1/memories/${ID}/ingest$`), 'ingest'],
      ['GET', new RegExp(`^/v1/memories/${ID}/ingestions$`), 'ingestionList'],
      ['GET', new RegExp(`^/v1/memories/${ID}/ingestions/${ID}$`), 'ingestionGet'],
      ['POST', new RegExp(`^/v1/memories/${ID}/procedures$`), 'procedures'],
    ] : []),
  ];
  return {actions, routes, start, jobs, ingestions, running: () => running};
}
