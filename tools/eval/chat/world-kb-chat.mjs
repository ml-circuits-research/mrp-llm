/**
 * The 30-question chat check of the base memory world-v1 (eval/world-kb/questions.json), through the HTTP chat of a PRIVATE server:
 * this script starts `server/http.mjs` on a private loopback port (never 9999) with its own API key, opens one session on the base
 * memory per question (POST /v1/sessions, then POST /v1/chat/completions with that session_id) and stops the server afterwards.
 * the step-by-step formalizer, the KnowledgeLinker, the memory slice and the engine are the product's own; nothing is stubbed. A question
 * in Romanian is sent as it is (the chat API has no `language` parameter since the English-only core; the formalizer reads any language).
 *   node tools/eval/chat/world-kb-chat.mjs [--port 19099] [--only q01,q02] [--base world-v1] [--chat-data <root>] [--out <dir>]
 * Writes eval/reports/current/world-kb/chat-results.json (every answer with the formalization, the circuit and the packet status).
 * The chat data root defaults to the product root (chat_data/), where world-v1 is loaded by tools/world-kb/load.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', 19099));
if (port === 9999) throw new Error('port 9999 belongs to the owner server');
const base = opt('--base', 'world-v1');
const only = opt('--only', null)?.split(',');
const outDir = path.resolve(project, opt('--out', 'eval/reports/current/world-kb'));
const questions = JSON.parse(fs.readFileSync(path.join(project, 'eval/world-kb/questions.json'), 'utf8')).filter(q => !only || only.includes(q.id));
const entities = JSON.parse(fs.readFileSync(path.join(project, 'datasets_sources/world-kb/entities.json'), 'utf8'));
const key = randomBytes(18).toString('hex');
const env = {...process.env, CHATSOP_PORT: String(port), CHATSOP_HOST: '127.0.0.1', CHATSOP_API_KEY: key, ...(opt('--chat-data', null) ? {CHATSOP_CHAT_DATA: path.resolve(opt('--chat-data'))} : {})};
fs.mkdirSync(outDir, {recursive: true});
const log = fs.openSync(path.join(outDir, 'server.log'), 'w');
const server = spawn('node', ['server/http.mjs'], {cwd: project, env, stdio: ['ignore', log, log]});
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(1); });
const url = p => `http://127.0.0.1:${port}${p}`;
const call = async (method, p, body, timeoutMs = 240000) => {
  const r = await fetch(url(p), {method, headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs)});
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return {status: r.status, json, text};
};
for (let i = 0; ; i++) {
  try { if ((await fetch(url('/health'), {signal: AbortSignal.timeout(2000)})).status < 500) break; } catch {}
  if (i > 120) { stop(); throw new Error('the private server did not start; see server.log'); }
  await new Promise(r => setTimeout(r, 1000));
}

const label = s => (entities[s]?.en ?? s).toLowerCase();
const norm = s => String(s).toLowerCase().replace(/_/g, ' ').normalize('NFKD').replace(/\p{M}/gu, '');
const results = [];
for (const q of questions) {
  const session = await call('POST', '/v1/sessions', {base, name: `world-check-${q.id}`});
  const sid = session.json?.id ?? session.json?.session?.id;
  const t0 = Date.now();
  let res;
  try { res = await call('POST', '/v1/chat/completions', {model: 'chatsop-local', session_id: sid, messages: [{role: 'user', content: q.q}]}); }
  catch (error) { res = {status: 0, json: null, text: String(error)}; }
  const ms = Date.now() - t0;
  const c = res.json?.chatSop ?? {};
  const answer = res.json?.choices?.[0]?.message?.content ?? '';
  const blob = norm(answer + ' ' + JSON.stringify(c.provenance ?? []) + ' ' + JSON.stringify(c.status ?? ''));
  const wanted = q.expect.map(e => [norm(e), norm(label(e))]);
  const matched = q.expect.filter((e, i) => blob.includes(wanted[i][0]) || blob.includes(wanted[i][1]));
  results.push({id: q.id, kind: q.kind, lang: q.lang, question: q.q, http: res.status, ms, answer, expected: q.expect, matched, pass: matched.length > 0,
    status: c.status ?? null, model_sop: c.model_sop ?? null, circuit: c.circuit ?? null, required: c.required ?? null, completeness: c.completeness ?? null, backend: c.backend ?? null,
    understood_as: c.understood_as ?? null, unclear: c.unclear ?? null, error: res.status === 200 ? null : (res.json?.error?.message ?? res.text.slice(0, 300)), rejection: res.json?.chatSop?.rejection ?? null, session: sid});
  console.error(q.id, res.status, ms + 'ms', c.status ?? '-', '|', answer.replace(/\s+/g, ' ').slice(0, 120), matched.length ? 'PASS' : 'FAIL');
  if (sid) await call('DELETE', `/v1/sessions/${sid}`).catch(() => {});
}
stop();
fs.writeFileSync(path.join(outDir, 'chat-results.json'), JSON.stringify({base, port, ran_at: new Date().toISOString(), results}, null, 1));
console.log(JSON.stringify({passed: results.filter(r => r.pass).length, total: results.length}));
