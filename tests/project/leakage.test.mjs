// The source-boundary guard (eval/leakage.mjs, DS012 "Sealed tests and leakage"): generators and selection code never read a sealed test, and a sealed
// programming test lives under eval/suites only. The guard stays for the benchmark (experiments/proposal/symbolic-vs-llm-benchmark.md) that reuses
// the generator tools/datasets/diversity.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {auditSourceBoundary, auditSealedTests, generatorSources} from '../../eval/leakage.mjs';
import {repoPath} from '../helpers.mjs';

test('no generator of tools/datasets reads a sealed test, and no sealed programming test lives outside eval/suites', () => {
  const root = repoPath();
  const report = auditSourceBoundary(root);
  assert.deepEqual(report.violations, []);
  assert.ok(generatorSources(root).some(file => file.startsWith('tools/datasets/diversity/')), 'the diversity generator is inspected');
  assert.deepEqual(auditSealedTests(root).violations, []);
});

test('the guard flags a generator that reads a sealed test.jsonl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsop-leak-'));
  try {
    fs.mkdirSync(path.join(root, 'tools/datasets'), {recursive: true});
    fs.writeFileSync(path.join(root, 'tools/datasets/build-x.mjs'), "import fs from 'node:fs';\nfs.readFileSync('eval/suites/x/test.jsonl');\n");
    const report = auditSourceBoundary(root);
    assert.ok(report.violations.some(v => /sealed-answer/.test(v)), report.violations.join('; '));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
