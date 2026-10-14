#!/usr/bin/env node
/** Runs the declarative example through the real host path: model-origin
 * declarative SOP (the model language) in, host-compiled circuit out, plus an answer
 * grounded in the user's statement and a reported, unused model assumption.
 * No model endpoint is required; this exercises admission, compilation and
 * execution, not language-model quality.
 */
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../sop/runtime.mjs';
import {Repository} from '../memory/repository.mjs';
import {Lexicon} from '../sop/lexicon.mjs';
import {publishKnowledge} from '../sop/ingest.mjs';
import {MODEL_TYPES} from '../sop/declarative.mjs';
import {parse} from '../sop/parser.mjs';
import {assert} from '../lib/util.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsop-declarative-demo-'));
try {
  const lexicon = demoLexicon();
  const repo = new Repository(root, {memory: {engine: 'sqlite', power: 10}});
  publishKnowledge(repo, 'demo', fs.readFileSync(new URL('../tests/fixtures/bootstrap.sop', import.meta.url), 'utf8'), {schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2024-01-01')});
  const session = repo.session('demo', 'local', 'demo');
  const source = fs.readFileSync(new URL('./declarative.sop', import.meta.url), 'utf8');
  const authored = parse(source);
  assert(authored.wires.every(wire => MODEL_TYPES.has(wire.type)), 'Example must stay declarative');
  const result = await new Runtime({repo, session, schema: lexicon.predicates, lexicon, now: Date.parse('2026-09-26T12:00:00Z')}).run(source, {origin: 'model', inputText: 'Carina is a parent of Ana. Who is Carina a parent of?', language: 'en'});
  assert(result.result.packet.status === 'supported', 'Example question must be supported by the user statement');
  assert(result.result.packet.hypothetical !== true, 'An asserted user statement is evidence for this turn, not a hypothesis');
  assert(result.result.packet.model_assumptions.length === 1 && result.result.packet.model_assumptions[0].treatment === 'reported', 'The model assumption is reported, not used');
  assert(Object.keys(session.live.claims).length === 0, 'User statements must not become repository claims');
  assert(/\@\w+ solve/.test(result.executionSop), 'Host must generate the execution circuit');
  console.log('authored:');console.log(result.authoredSop);
  console.log('host circuit:');console.log(result.executionSop);
  console.log('result:');
  console.log(JSON.stringify({status: result.result.packet.status, hypothetical: result.result.packet.hypothetical, answers: (result.result.packet.answers ?? []).map(answer => answer.binding), repositoryClaims: Object.keys(session.live.claims).length, userStatements: result.result.packet.user_statements.map(s => s.statement), modelAssumptions: result.result.packet.model_assumptions.map(a => a.statement)}, null, 2));
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
