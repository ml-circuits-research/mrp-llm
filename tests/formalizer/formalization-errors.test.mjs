// The formalization error inbox (lib/formalization-errors.mjs, AGENTS.md "Formalization improvement"): every reporter appends one JSON
// line per case to an append-only file; a case without source or message, or of an unknown kind, is refused and nothing is written.
// Offline: the inbox is a temporary file, never state/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ERROR_KINDS, INBOX, reportFormalizationError} from '../../lib/formalization-errors.mjs';
import {repoPath, tempDir} from '../helpers.mjs';

const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('a case is appended as one JSON line with every field; the folder is created; earlier lines are kept', t => {
  const file = path.join(tempDir(t, 'inbox-'), 'nested', 'inbox.jsonl');
  const now = () => new Date('2026-10-03T12:00:00Z');
  const first = reportFormalizationError({source: 'eval:books', kind: 'wrong', message: 'How many pens?', strategy: 'LocalLLMStepByStep', tier: 'tiny', circuit: '@q query\n  mode count\n', expected: '12', detail: 'counted the wrong relation', ref: 'run-1#b17'}, {file, now});
  reportFormalizationError({source: 'chat-audit', kind: 'parse_failed', message: 'Is Zork in Portugal?'}, {file, now});
  const rows = lines(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], first);
  assert.deepEqual(rows[0], {t: '2026-10-03T12:00:00.000Z', source: 'eval:books', kind: 'wrong', message: 'How many pens?', strategy: 'LocalLLMStepByStep', tier: 'tiny', circuit: '@q query\n  mode count\n', expected: '12', detail: 'counted the wrong relation', ref: 'run-1#b17'});
  assert.deepEqual(rows[1], {t: '2026-10-03T12:00:00.000Z', source: 'chat-audit', kind: 'parse_failed', message: 'Is Zork in Portugal?', strategy: null, tier: null, circuit: null, expected: null, detail: null, ref: null}, 'optional fields are null, never absent');
});

test('every documented kind is accepted; an unknown kind, a missing source or message is refused before anything is written', t => {
  const file = path.join(tempDir(t, 'inbox-'), 'inbox.jsonl');
  assert.deepEqual(ERROR_KINDS, ['parse_failed', 'invalid', 'wrong', 'unclear', 'missing_construct']);
  for (const kind of ERROR_KINDS) reportFormalizationError({source: 's', kind, message: 'm'}, {file});
  assert.deepEqual(lines(file).map(r => r.kind), ERROR_KINDS);
  assert.throws(() => reportFormalizationError({source: 's', kind: 'typo', message: 'm'}, {file}), /kind must be one of/);
  assert.throws(() => reportFormalizationError({kind: 'wrong', message: 'm'}, {file}), /source and message are required/);
  assert.throws(() => reportFormalizationError({source: 's', kind: 'wrong'}, {file}), /source and message are required/);
  assert.equal(lines(file).length, ERROR_KINDS.length, 'a refused case writes nothing');
});

test('the default inbox is the append-only file under state/ (gitignored, operational)', () => {
  assert.equal(INBOX, repoPath('state/formalization-errors/inbox.jsonl'));
});
