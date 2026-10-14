#!/usr/bin/env node
/**
 * Acceptance check of the per-session lexicon (linking proposal M0): real questions through the HTTP chat of a PRIVATE server
 * (loopback, a port of its own, never 9999, its own API key) against a named base memory, one session per question. The server,
 * the step-by-step formalizer (its questions to the Ploinky tier ladder), the KnowledgeLinker, the memory slice and the engine are the product's own; nothing is stubbed.
 *
 *   node tools/linking/acceptance-chat.mjs [--base world-v1] [--port 19131] [--chat-data ROOT] [--out DIR] [--questions FILE]
 *
 * `--questions` is a JSON array of {id, q, expect: [words that must appear in the answer, folded], lang?}; the default asks
 * "Who is Ada Lovelace?", "Is Paris a city?" and "Where is Paris?". Writes DIR/acceptance-<base>.json (every answer with the
 * `linking` report, the status and the circuit). Exit code 1 when a question fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', 19131));
if (port === 9999) throw new Error('port 9999 belongs to the owner server');
const base = opt('--base', 'world-v1');
const outDir = path.resolve(project, opt('--out', 'eval/reports/current/linking'));
const questions = opt('--questions', null) ? JSON.parse(fs.readFileSync(path.resolve(opt('--questions')), 'utf8')) : [
  {id: 'ada', q: 'Who is Ada Lovelace?', expect: ['ada lovelace']},
  {id: 'paris-city', q: 'Is Paris a city?', expect: ['paris']},
  {id: 'paris-where', q: 'Where is Paris?', expect: ['france']},
];
const key = randomBytes(18).toString('hex');
const env = {...process.env, CHATSOP_PORT: String(port), CHATSOP_HOST: '127.0.0.1', CHATSOP_API_KEY: key, ...(opt('--chat-data', null) ? {CHATSOP_CHAT_DATA: path.resolve(opt('--chat-data'))} : {})};
fs.mkdirSync(outDir, {recursive: true});
const log = fs.openSync(path.join(outDir, `acceptance-${base}-server.log`), 'w');
const server = spawn('node', ['server/http.mjs'], {cwd: project, env, stdio: ['ignore', log, log]});
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);
const url = p => `http://127.0.0.1:${port}${p}`;
const call = async (method, p, body, timeoutMs = 240000) => {
  const r = await fetch(url(p), {method, headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs)});
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: r.status, json, text};
};
for (let i = 0; ; i++) {
  try { if ((await fetch(url('/health'), {signal: AbortSignal.timeout(2000)})).status < 500) break; } catch { /* not up yet */ }
  if (i > 120) { stop(); throw new Error('the private server did not start; see ' + path.join(outDir, `acceptance-${base}-server.log`)); }
  await new Promise(r => setTimeout(r, 1000));
}
const norm = s => String(s).toLowerCase().replace(/_/g, ' ').normalize('NFKD').replace(/\p{M}/gu, '');
const results = [];
for (const q of questions) {
  const session = await call('POST', '/v1/sessions', {base, name: `linking-acceptance-${q.id}`});
  const sid = session.json?.id ?? session.json?.session?.id;
  const t0 = Date.now();
  let res;
  try { res = await call('POST', '/v1/chat/completions', {model: 'chatsop-local', session_id: sid, messages: [{role: 'user', content: q.q}]}); }
  catch (error) { res = {status: 0, json: null, text: String(error)}; }
  const c = res.json?.chatSop ?? {};
  const answer = res.json?.choices?.[0]?.message?.content ?? '';
  const blob = norm(answer + ' ' + JSON.stringify(c.provenance ?? []));
  const matched = q.expect.filter(e => blob.includes(norm(e)));
  results.push({id: q.id, question: q.q, http: res.status, ms: Date.now() - t0, answer, expected: q.expect, matched, pass: res.status === 200 && matched.length === q.expect.length,
    status: c.status ?? null, linking: c.linking ?? [], model_sop: c.model_sop ?? null, circuit: c.circuit ?? null, required: c.required ?? null, backend: c.backend ?? null,
    error: res.status === 200 ? null : (res.json?.error?.message ?? res.text.slice(0, 300)), session: sid});
  console.error(q.id, res.status, (Date.now() - t0) + 'ms', c.status ?? '-', '|', answer.replace(/\s+/g, ' ').slice(0, 140), results.at(-1).pass ? 'PASS' : 'FAIL');
  if (sid) await call('DELETE', `/v1/sessions/${sid}`).catch(() => {});
}
stop();
fs.writeFileSync(path.join(outDir, `acceptance-${base}.json`), JSON.stringify({base, port, ran_at: new Date().toISOString(), results}, null, 1));
const passed = results.filter(r => r.pass).length;
console.log(JSON.stringify({base, passed, total: results.length}));
process.exit(passed === results.length ? 0 : 1);
