// The inventory of tests and evaluations (eval/registry.json, tools/inventory/tests-and-evals.mjs; owner request 2026-10-03): every test
// file, every tools/eval and tools/capabilities file, every eval/ data folder, every verify job and every package script is mapped to a
// registry entry, every entry's paths exist, and docs/tests-inventory.html was generated from the current registry. Offline, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ROOT, PAGE, check, covers, registryDigest, scanTree} from '../../tools/inventory/tests-and-evals.mjs';

test('every test, harness, eval data folder, verify job and script is registered; every registered path exists', () => {
  const {problems} = check(ROOT);
  assert.deepEqual(problems, [], 'fix eval/registry.json, then run node tools/inventory/tests-and-evals.mjs');
});

test('the page is generated from the current registry', () => {
  const page = fs.readFileSync(path.join(ROOT, PAGE), 'utf8');
  const digest = page.match(/<meta name="registry-digest" content="([0-9a-f]{64})">/)?.[1];
  assert.equal(digest, registryDigest(ROOT), 'run node tools/inventory/tests-and-evals.mjs to regenerate docs/tests-inventory.html');
});

test('an unregistered test file or a missing path is reported', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const write = (p, text) => { fs.mkdirSync(path.dirname(path.join(root, p)), {recursive: true}); fs.writeFileSync(path.join(root, p), text); };
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/registry.json'), 'utf8'));
  const entry = {...registry.entries.find(e => e.id === 'tests-sop-syntax'), paths: ['tests/a.test.mjs', 'tests/gone.test.mjs', 'eval/smoke/']};
  write('eval/registry.json', JSON.stringify({...registry, headlineOrder: [], entries: [{...entry, verifyJobs: ['node-tests'], scripts: ['test']}]}));
  write('tests/a.test.mjs', '');
  write('tests/b.test.mjs', '');
  write('tools/eval/new-harness.mjs', '');
  write('eval/smoke/case.sop', '');
  write('eval/orphan/data.json', '{}');
  write('tools/verify.mjs', "const jobs=[\n ['node-tests',process.execPath,[]],\n ['extra-job',process.execPath,[]]\n];");
  write('package.json', JSON.stringify({scripts: {test: 'x', lint: 'y'}}));
  const {problems} = check(root);
  for (const expected of ['test file tests/b.test.mjs is not mapped', 'harness file tools/eval/new-harness.mjs is not mapped', 'eval data eval/orphan/ is not mapped', 'path tests/gone.test.mjs does not exist', 'verify job extra-job is not mapped', 'package script lint is not mapped'])
    assert.ok(problems.some(p => p.includes(expected)), `${expected}\n${problems.join('\n')}`);
  assert.ok(!problems.some(p => p.includes('tests/a.test.mjs is not mapped') || p.includes('eval/smoke/ is not mapped')));
});

test('coverage rule: a file, a folder that contains it, or a path inside a scanned folder', () => {
  assert.ok(covers('tests/a.test.mjs', 'tests/a.test.mjs'));
  assert.ok(covers('tools/eval/kbqa/', 'tools/eval/kbqa/run.mjs'));
  assert.ok(covers('eval/world-kb/questions.json', 'eval/world-kb/'));
  assert.ok(!covers('tools/eval/kbqa', 'tools/eval/kbqa/run.mjs'));
  assert.ok(!covers('tests/a.test.mjs', 'tests/ab.test.mjs'));
  const scan = scanTree(ROOT);
  assert.ok(scan.testFiles.includes('tests/project/tests-inventory.test.mjs') && scan.verifyJobs.includes('node-tests') && scan.scripts.includes('test'));
});
