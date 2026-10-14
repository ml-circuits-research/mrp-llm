#!/usr/bin/env node
/**
 * Replays the turns of an end-to-end chat check through a running private server (never port 9999 of the owner's server):
 * one `POST /v1/chat/completions` per turn with the user's message (`message`; `--sent yes` replays the text the 2026-10-01 run sent
 * after its clean-English step, which the chat no longer has), sessions shared by the turns of one conversation, and records the
 * answer text, status, completeness, timing and the trace fields to a JSONL file.
 *
 *   node tools/eval/chat/e2e-chat.mjs --base http://127.0.0.1:19778 --in eval/reports/current/e2e-chat/turns.jsonl --out FILE.jsonl [--password P] [--memory world-v1] [--sent yes]
 *
 * The server must be started on a private port with its own data root (CHATSOP_PORT, CHATSOP_CHAT_DATA, CHATSOP_CONFIG).
 */
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const base = args.base ?? 'http://127.0.0.1:19778', password = args.password ?? 'e2e-fix-password', memory = args.memory ?? 'world-v1';
if (/:9999\b/.test(base)) throw new Error('refusing to use port 9999');
const turns = fs.readFileSync(args.in, 'utf8').trim().split('\n').map(JSON.parse);
let cookie = '';
const call = async (route, {method = 'GET', body, timeoutMs = 60000} = {}) => {
  const res = await fetch(base + route, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {cookie} : {})}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs)});
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return {status: res.status, json, text};
};
const login = await call('/admin/login', {method: 'POST', body: {password}});
if (login.status !== 200) { const setup = await call('/admin/setup', {method: 'POST', body: {password}}); if (setup.status !== 200) throw new Error('cannot sign in: ' + setup.text); }

const groupOf = id => (/^s0\d$/.test(id) ? 'g-s' : /^st0\d$/.test(id) ? 'g-st' : id);
let group = null, session = null, n = 0;
const out = [];
for (const turn of turns) {
  const key = groupOf(turn.id);
  if (key !== group) {
    group = key;
    const id = `e2e-${Date.now().toString(36)}-${n++}`;
    const made = await call('/v1/sessions', {method: 'POST', body: {base: memory, id, name: 'e2e ' + key}});
    if (made.status >= 300) throw new Error('session: ' + made.text);
    session = id;
  }
  const started = Date.now();
  const body = {model: 'chatsop-local', session_id: session, messages: [{role: 'user', content: args.sent === 'yes' ? turn.sent ?? turn.message : turn.message}]};
  let res;
  try { res = await call('/v1/chat/completions', {method: 'POST', body, timeoutMs: 45000}); } catch (error) { res = {status: 0, json: null, text: String(error.message)}; }
  const sop = res.json?.chatSop;
  const row = {id: turn.id, message: turn.message, sent: body.messages[0].content, http: res.status, ms: Date.now() - started,
    answer: res.json?.choices?.[0]?.message?.content ?? res.json?.error?.message ?? res.text.slice(0, 300), status: sop?.status ?? null, complete: sop?.completeness ?? null,
    route: sop?.route ?? null, has_retrieval: Boolean(sop?.retrieval), parse: sop?.parse ? {model: sop.parse.model ?? null, rounds: sop.parse.rounds ?? null, ms: sop.parse.ms ?? null, cost_usd: sop.parse.cost_usd ?? null} : null,
    linking: (sop?.linking ?? []).filter(l => l.kind === 'entity').map(l => ({surface: l.surface, symbol: l.symbol, via: l.via}))};
  out.push(row);
  console.log(`${row.id}\t${row.http}\t${row.ms} ms\t${row.status}\t${String(row.answer).split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);
}
if (args.out) fs.writeFileSync(args.out, out.map(r => JSON.stringify(r)).join('\n') + '\n');
