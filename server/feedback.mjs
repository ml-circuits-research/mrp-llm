/**
 * Chat feedback (DS022 "Chat feedback", docs/api.html): a thumbs-up or thumbs-down vote on one answered chat turn, joined on the server to
 * the turn record of the session transcript (message, strategy, model, circuits, status, answer text, trace id) and routed by its cause.
 *
 *   POST /v1/feedback                        {session, turn, vote: up|down, cause?, comment?}: record a vote (cause required for down)
 *   GET  /v1/feedback                        the recent votes, newest first, grouped by cause (signed-in administrator session only)
 *   GET  /v1/feedback/stats                  counts per vote and per cause, over the latest vote of each turn
 *   GET  /v1/sessions/{id}/turns/{turn}      the recorded turn (what the vote is about)
 *
 * Every vote is appended to `state/feedback/chat-feedback.jsonl` (append-only, gitignored). A down vote is routed deterministically by
 * its cause, once per turn and cause: not understood -> the formalization error inbox (kind `wrong`, lib/formalization-errors.mjs);
 * unnecessary question -> the inbox (kind `unclear`); missing knowledge -> the knowledge-gap queue `query-gaps.jsonl` of the chat data
 * root (the file logGap of server/query-parser.mjs writes); bad wording or tone -> `state/feedback/reply-layer.jsonl` (for the
 * conversation-layer wires); wrong answer -> `state/feedback/answer-wrong.jsonl`. The cause labels the user sees are UI chrome of the chat page.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reportFormalizationError, INBOX} from '../lib/formalization-errors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FEEDBACK_DIR = path.join(ROOT, 'state/feedback');
export const FEEDBACK_LOG = 'chat-feedback.jsonl';

/** The causes of a down vote and where each is routed. */
export const FEEDBACK_CAUSES = Object.freeze({
  not_understood: Object.freeze({route: 'formalization', kind: 'wrong'}),
  wrong_answer: Object.freeze({route: 'answer-wrong'}),
  missing_knowledge: Object.freeze({route: 'knowledge-gap'}),
  unnecessary_question: Object.freeze({route: 'formalization', kind: 'unclear'}),
  bad_wording: Object.freeze({route: 'reply-layer'}),
});
export const VOTES = Object.freeze(['up', 'down']);
export const MAX_COMMENT = 2000;

export const FEEDBACK_ENDPOINTS = Object.freeze([
  {method: 'POST', path: '/v1/feedback', capability: 'feedback', body: ['session', 'turn', 'vote', 'cause', 'comment']},
  {method: 'GET', path: '/v1/feedback', capability: 'feedback.list'},
  {method: 'GET', path: '/v1/feedback/stats', capability: 'feedback.stats'},
  {method: 'GET', path: '/v1/sessions/{id}/turns/{turn}', capability: 'sessions.turn'},
]);

const bad = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {status, code});
const ID = '([a-z0-9][a-z0-9_-]{0,63})';
const append = (file, row) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.appendFileSync(file, JSON.stringify(row) + '\n'); };
const readRows = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const keyOf = r => `${r.session}\0${r.turn}\0${r.user}`;

/** Validates a vote body; returns {session, turn, vote, cause, comment}. */
export function checkFeedback(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Expected a JSON object');
  const allowed = FEEDBACK_ENDPOINTS[0].body;
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw bad(`Unsupported parameter ${JSON.stringify(extra[0])}; accepted: ${allowed.join(', ')}`, 'unsupported_parameter');
  const {session, turn, vote, cause = null, comment = null} = body;
  if (typeof session !== 'string' || !new RegExp(`^${ID}$`).test(session)) throw bad('session must be a session id (chatSop.session.id of the answer)', 'invalid_parameter');
  if (!Number.isSafeInteger(turn) || turn < 1) throw bad('turn must be a positive integer (chatSop.turn of the answer)', 'invalid_parameter');
  if (!VOTES.includes(vote)) throw bad(`vote must be one of ${VOTES.join(', ')}`, 'invalid_parameter');
  if (vote === 'down' && !Object.hasOwn(FEEDBACK_CAUSES, cause)) throw bad(`A down vote needs cause, one of ${Object.keys(FEEDBACK_CAUSES).join(', ')}`, 'invalid_parameter');
  if (vote === 'up' && cause !== null) throw bad('An up vote has no cause', 'invalid_parameter');
  if (comment !== null && (typeof comment !== 'string' || comment.length > MAX_COMMENT)) throw bad(`comment must be a string of at most ${MAX_COMMENT} characters`, 'invalid_parameter');
  return {session, turn, vote, cause, comment: comment?.trim() || null};
}

/** Counts over the latest vote of each (session, turn, user). */
export function feedbackStats(rows) {
  const latest = new Map();
  for (const r of rows) latest.set(keyOf(r), r);
  const causes = Object.fromEntries(Object.keys(FEEDBACK_CAUSES).map(c => [c, 0]));
  const votes = {up: 0, down: 0};
  for (const r of latest.values()) { votes[r.vote] = (votes[r.vote] ?? 0) + 1; if (r.vote === 'down' && r.cause in causes) causes[r.cause]++; }
  return {votes, causes, turns: latest.size, records: rows.length};
}

/**
 * The feedback routes for the product router (`extra`). `dir`: where chat-feedback.jsonl, reply-layer.jsonl and answer-wrong.jsonl go;
 * `inbox`: the formalization error inbox; `gapsFile`: the knowledge-gap queue (query-gaps.jsonl of the chat data root).
 */
export function createFeedback({sessions, readBody, json, dir = FEEDBACK_DIR, inbox = INBOX, gapsFile = null, now = () => new Date(), maxBytes = 16_384, onVote = null}) {
  const logFile = path.join(dir, FEEDBACK_LOG);
  const files = {'reply-layer': path.join(dir, 'reply-layer.jsonl'), 'answer-wrong': path.join(dir, 'answer-wrong.jsonl'), 'knowledge-gap': gapsFile};

  /** Routes one down vote; returns where it went. */
  function route(row) {
    const spec = FEEDBACK_CAUSES[row.cause];
    const r = row.record;
    const ref = `${row.session}#${row.turn}`;
    if (spec.route === 'formalization') {
      reportFormalizationError({source: 'chat-feedback', kind: spec.kind, message: r.message, strategy: r.strategy, tier: r.model, circuit: r.model_sop ?? r.circuit, detail: row.comment, ref}, {file: inbox, now});
      return {route: 'formalization', kind: spec.kind};
    }
    const file = files[spec.route];
    if (!file) return {route: spec.route, skipped: 'no queue file configured'};
    const entry = spec.route === 'knowledge-gap'
      ? {ts: row.t, source: 'chat-feedback', kind: 'missing_knowledge', message: r.message, memory: row.base, circuit: r.model_sop ?? r.circuit, answer: r.answer, comment: row.comment, ref}
      : {t: row.t, source: 'chat-feedback', cause: row.cause, message: r.message, answer: r.answer, status: r.status, strategy: r.strategy, model: r.model, circuit: r.circuit, comment: row.comment, ref, trace_id: r.trace_id};
    append(file, entry);
    return {route: spec.route};
  }

  const actions = {
    async feedbackCreate({req, res, user, admin}) {
      const vote = checkFeedback(await readBody(req, maxBytes));
      const info = sessions.visible(vote.session, {user, admin});
      const turn = sessions.turn(vote.session, vote.turn);
      if (!turn) throw bad(`Session ${vote.session} has no answered turn ${vote.turn}`, 'turn_not_found', 404);
      const record = {message: turn.message ?? null, answer: turn.text ?? null, status: turn.status ?? null, strategy: turn.strategy ?? null, model: turn.model ?? null,
        model_sop: turn.model_sop ?? null, circuit: turn.circuit ?? null, reasoning_strategy: turn.reasoning_strategy ?? null, trace_id: turn.trace_id ?? null};
      const row = {t: now().toISOString(), user, session: vote.session, base: info.base?.id ?? info.base ?? null, turn: vote.turn, vote: vote.vote, cause: vote.cause, comment: vote.comment, record};
      // A repeated vote with the same cause for the same turn is recorded again but routed only once.
      const previous = readRows(logFile).findLast(r => keyOf(r) === keyOf(row));
      const duplicate = Boolean(previous && previous.vote === row.vote && previous.cause === row.cause);
      row.routed = row.vote === 'down' && !duplicate ? route(row) : null;
      append(logFile, row);
      // A listener sees every new vote with its turn (the MRP layer learns the reflex boundary from votes on reflex answers, DS025).
      if (!duplicate) { try { onVote?.(turn, row); } catch { /* a listener never fails the vote */ } }
      json(res, 201, {object: 'feedback', session: row.session, turn: row.turn, vote: row.vote, cause: row.cause, routed: row.routed, duplicate, trace_id: record.trace_id});
    },
    feedbackList({req, res, admin}) {
      if (!admin) throw bad('The feedback list needs the signed-in administrator session', 'forbidden', 403);
      const limit = Math.min(Math.max(Number(new URL(req.url, 'http://localhost').searchParams.get('limit')) || 200, 1), 2000);
      const rows = readRows(logFile);
      const recent = rows.slice(-limit).reverse();
      const groups = Object.fromEntries(['up', ...Object.keys(FEEDBACK_CAUSES)].map(k => [k, []]));
      for (const r of recent) groups[r.vote === 'up' ? 'up' : r.cause]?.push(r);
      json(res, 200, {object: 'feedback.list', data: recent, groups, stats: feedbackStats(rows)});
    },
    feedbackStats({res}) { json(res, 200, {object: 'feedback.stats', ...feedbackStats(readRows(logFile))}); },
    sessionsTurn({res, match, user, admin}) {
      sessions.visible(match[1], {user, admin});
      const turn = sessions.turn(match[1], Number(match[2]));
      if (!turn) throw bad(`Session ${match[1]} has no answered turn ${match[2]}`, 'turn_not_found', 404);
      json(res, 200, {object: 'session.turn', session: match[1], ...turn});
    },
  };
  const routes = [
    ['POST', /^\/v1\/feedback$/, 'feedbackCreate'],
    ['GET', /^\/v1\/feedback$/, 'feedbackList'],
    ['GET', /^\/v1\/feedback\/stats$/, 'feedbackStats'],
    ['GET', new RegExp(`^/v1/sessions/${ID}/turns/([1-9][0-9]{0,8})$`), 'sessionsTurn'],
  ];
  return {actions, routes, files: {log: logFile, inbox, ...files}};
}
