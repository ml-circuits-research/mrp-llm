// Every model call of the project goes through Ploinky Workers (the pworker dependency): no project file names a model endpoint, the
// server's port in a URL, a provider's host or the request headers of the model API; and the names of the components Ploinky
// replaced (the earlier proxy and job runner) appear only in history (the archive, the journal and notes, CHANGES.md, delivered-work
// records). Code reaches models only through lib/pworker.mjs (or Ploinky's own library and CLI).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {cwd: ROOT, encoding: 'utf8'}).split('\n').filter(Boolean).filter(f => fs.existsSync(path.join(ROOT, f)));

// History and the archive keep their words.
const HISTORY = [/^probably_obsolete\//, /^status\//, /^CHANGES\.md$/, /^PAS_TASK\.md$/, /^eval\/reports\/history\//, /^experiments\/(?!proposal\/)/];
const skip = f => HISTORY.some(r => r.test(f)) || f === 'tests/pworker/no-direct-model-calls.test.mjs';
// The project's one access point to Ploinky documents the server's address.
const ACCESS = new Set(['lib/pworker.mjs']);
const text = f => /\.(mjs|js|cjs|json|jsonl|md|html|sh|txt|sop|yml|yaml|css)$|^[^.]+$/.test(f);

test('no file outside Ploinky calls a model endpoint directly', () => {
  // Code that serves ChatSOP's own chat API (/v1/chat/completions of the chat server) is not a model call.
  const SERVES_CHAT_API = new Set(['server/http.mjs', 'server/pages/chat.mjs', 'server/pages/chat-product.mjs', 'server/project.mjs', 'tools/serve-local.mjs', 'tools/linking/acceptance-chat.mjs', 'tools/eval/chat/e2e-chat.mjs', 'tools/docs/architecture/diagrams.mjs']);
  const bad = [];
  const ENDPOINT = /(127\.0\.0\.1|localhost):(18080|1961\d)\b|api\.openference\.com|openrouter\.ai\/api|api\.deepseek\.com|\/u\/(openference|openrouter|deepseek|local\w*)\/v1/;
  // Request headers of the model API are Ploinky's business: code passes purpose, run, cache and priority as client options.
  const HEADERS = /['"`]x-pworker-(purpose|run|cache|priority|no-fallback)['"`]/;
  const CALL = /(fetch|request)\([^)]*(\/chat\/completions|\/v1\/messages|\/v1\/structure|\/v1\/fol)/;
  for (const f of files) {
    if (skip(f) || ACCESS.has(f) || f.startsWith('node_modules/') || f.startsWith('docs/') || f.startsWith('tests/') || !/\.(mjs|js|cjs|json|sh)$/.test(f)) continue;
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    s.split('\n').forEach((line, i) => {
      if (ENDPOINT.test(line) || (/\.m?js$/.test(f) && HEADERS.test(line))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
      else if (CALL.test(line) && !SERVES_CHAT_API.has(f)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(bad, [], `direct model calls (use lib/pworker.mjs):\n${bad.join('\n')}`);
});

test('the names of the replaced components appear only in history', () => {
  const bad = [];
  for (const f of files) {
    if (skip(f) || !text(f)) continue;
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/llmapiprovider|llmjobs/i.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, [], `rename to Ploinky (pworker):\n${bad.join('\n')}`);
});

// The owner's rename of 2026-10-03: the project modules Ploinky serves are TaskLambdas (Ploinky/README.md "TaskLambdas and
// TaskLambdaCalls"); the earlier name appears only in history. PENDING holds files of agents that were still running when the rename
// landed (TODO.md "TaskLambda rename"); this list only shrinks.
const OLD_LAMBDA_NAME = new RegExp(['skill', 'plugin'].join('[\\s_-]*'), 'i');
const PENDING = new Set([]);

test('the earlier name of a TaskLambda appears only in history', () => {
  const bad = [];
  for (const f of files) {
    if (HISTORY.some(r => r.test(f)) || PENDING.has(f) || !text(f) || !fs.statSync(path.join(ROOT, f)).isFile()) continue;
    if (OLD_LAMBDA_NAME.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) bad.push(f);
  }
  assert.deepEqual(bad, [], `rename to TaskLambda:\n${bad.join('\n')}`);
});
