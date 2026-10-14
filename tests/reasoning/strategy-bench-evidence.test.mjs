import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderEnglish} from '../../reasoning/slice/render-english.mjs';
import {Theory} from '../../reasoning/slice/wire.mjs';
import {runCompletion} from '../../reasoning/strategies/llm-agent/completion.mjs';
import {parseAnswer} from '../../reasoning/strategies/llm-agent/packet.mjs';
import {ask} from '../../reasoning/strategies/llm-agent/index.mjs';

const knowledge = `@bird predicate
  args subject:entity
  closed true
@flies predicate
  args subject:entity
@f1 fact
  holds bird "A Bird"
  valid 2026-01-01 2026-02-01
@f2 fact
  holds not flies penguin
@d1 default
  when bird ?x
  except injured ?x
  then flies ?x
  priority 1
@d2 default
  when penguin ?x
  then not flies ?x
  priority 2
  overrides $d1
@r1 rule
  when all
    bird ?x
    not injured ?x
  end
  then active ?x
@agg aggregate
  over bird ?x
  count ?x as ?n
  yields bird_count ?n
@guard integrity
  never all
    bird ?x
    injured ?x
  end
  witness ?x
  message "bird injured"
`;

test('renderer preserves explicit negative evidence, defaults, precedence, closedness, intervals, aggregate and integrity', () => {
  const text = renderEnglish(knowledge);
  assert.match(text, /The list of bird is complete/);
  assert.match(text, /explicitly not flies\(penguin\)/);
  assert.match(text, /2026-01-01 inclusive until 2026-02-01 exclusive/);
  assert.match(text, /unless injured\(\?x\)/);
  assert.match(text, /Overrides d1 when it fires/);
  assert.match(text, /Priority 2/);
  assert.match(text, /Strict logical rule: if \(bird\(\?x\) AND explicitly not injured\(\?x\)\)/);
  assert.match(text, /Aggregate over bird\(\?x\).*count \?x as \?n/);
  assert.match(text, /Integrity constraint: never \(bird\(\?x\) AND injured\(\?x\)\)/);
  assert.equal(renderEnglish(knowledge), text);
});

test('renderer accepts gold slices and refuses semantically incomplete Theory or unknown wires', () => {
  const theory = new Theory([{name: 'case', text: knowledge}]);
  assert.throws(() => renderEnglish(theory), /omits repository facts/);
  const subset = {wires: [...theory.predicates.values(), ...theory.recs.map(r => r.wire)], facts: [{id: 'f2', atom: {p: 'flies', a: ['penguin'], neg: true}, valid: {from: -Infinity, until: Infinity}}]};
  assert.match(renderEnglish(subset), /explicitly not flies\(penguin\)/);
  const duplicate = {wires: [...subset.wires, {id: 'f2', type: 'fact', fields: [{key: 'holds', value: 'not flies penguin', block: []}]}], facts: subset.facts};
  assert.equal(renderEnglish(duplicate).match(/\[@f2\]/g).length, 1, 'one retrieved fact appears exactly once');
  assert.throws(() => renderEnglish({...duplicate, facts: [{id: 'f2', atom: {p: 'flies', a: ['other'], neg: true}}]}), /Conflicting evidence/);
  assert.throws(() => renderEnglish({wires: [{id: 'u', type: 'action', fields: []}]}), /Unsupported evidence wire/);
  assert.throws(() => renderEnglish('@u predicate\n  strange true\n'), /Unsupported evidence field/);
});

/** A fake Ploinky transport: `answer(url, init)` gives {status, text} (or waits for the abort); every request is recorded. */
function fakePworker(answer) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null});
    const r = await answer(url, init);
    return {ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text};
  };
  return {fetchImpl, calls};
}
// A request that never answers: it ends at the client's abort (a timer keeps the loop alive, as an open socket would).
const never = init => new Promise((_, reject) => {
  const alive = setTimeout(() => reject(new Error('the client never aborted')), 5000);
  init.signal.addEventListener('abort', () => { clearTimeout(alive); reject(init.signal.reason); }, {once: true});
});

test('completion cache does not reuse an answer across different token ceilings', async t => {
  const ta = fakePworker(() => ({status: 200, text: JSON.stringify({choices: [{message: {content: '{"status":"unknown"}'}}], usage: {prompt_tokens: 17, completion_tokens: 5}})}));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-completion-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const opts = {backend: 'completion', model: 'small', fallbackModels: [], maxTokens: 23, cacheDir: directory, reasoning: 'direct', fetchImpl: ta.fetchImpl};
  const problem = {theory: {knowledge: '@bird predicate\n  args subject:entity\n'}, query: '@q query\n  where bird ?x\n'};
  const first = await ask(problem, {}, opts);
  assert.equal(first.status, 'unknown');
  assert.match(ta.calls[0].url, /\/v1\/chat\/completions$/);
  assert.deepEqual([ta.calls[0].body.model, ta.calls[0].body.max_tokens], ['small', 23], 'the Ploinky tier and the token ceiling');
  assert.equal(ta.calls[0].headers['x-pworker-no-fallback'], '1', 'no silent substitution');
  assert.equal(ta.calls[0].headers['x-pworker-purpose'], 'answer-llm-agent');
  const hit = await ask(problem, {}, opts);
  assert.equal(hit.llm.cached, true);
  assert.equal(ta.calls.length, 1);
  await ask(problem, {}, {...opts, maxTokens: 24});
  assert.equal(ta.calls.length, 2);
});

test('completion reports timeout, provider failure and malformed output without substituting omp', async t => {
  const reply = {slow: null, bad: {status: 200, text: 'not json'}, empty: {status: 200, text: '{"choices":[{"message":{"content":""}}]}'}, down: {status: 503, text: 'offline'}};
  let mode = 'down';
  const ta = fakePworker((url, init) => reply[mode] ?? never(init));
  const base = {model: 'local', prompt: 'hello', fetchImpl: ta.fetchImpl};
  mode = 'slow';
  const slow = await runCompletion({...base, timeoutMs: 20});
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
  assert.match(slow.error, /wall timeout/);
  mode = 'down';
  const unavailable = await runCompletion(base);
  assert.match(unavailable.error, /HTTP 503/);
  mode = 'bad';
  assert.match((await runCompletion(base)).error, /malformed completion JSON/);
  mode = 'empty';
  assert.match((await runCompletion(base)).error, /missing assistant text/);
  mode = 'down';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-failure-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const failed = await ask({source: 'A.', query: ''}, {}, {backend: 'completion', model: 'local', fallbackModels: [], cacheDir: directory, presentation: 'nl', reasoning: 'direct', fetchImpl: ta.fetchImpl});
  assert.equal(failed.reason, 'provider');
  assert.equal(failed.route.backend, 'completion:local');
  assert.ok(ta.calls.every(c => c.headers['x-pworker-no-fallback'] === '1'), 'every call keeps one model');
});

test('constraint packets retain possible/impossible and counterexample evidence', () => {
  assert.deepEqual(parseAnswer('{\"status\":\"possible\",\"witness\":{\"x\":2},\"counterexample\":{\"x\":3}}').packet.counterexample, {x: 3});
  assert.equal(parseAnswer('{\"status\":\"impossible\"}').packet.status, 'impossible');
  assert.equal(parseAnswer('{\"status\":\"possible\",\"counterexample\":{\"x\":{}}}').ok, false);
});
