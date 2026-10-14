// Sharded JSONL storage (lib/jsonl-shards.mjs): size-bounded parts, whole lines, stale-part cleanup, readers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {tempDir} from '../helpers.mjs';
import {writeJsonlSharded, writeJsonlShardedSync, readJsonlSharded, readJsonlShardedSync, shardPaths, jsonlExists, splitJsonlFile, hashJsonlSharded} from '../../lib/jsonl-shards.mjs';
import {readJSONL} from '../../lib/util.mjs';

const rows = n => Array.from({length: n}, (_, i) => ({id: `r${i}`, text: 'x'.repeat(40 + (i % 7))}));
const collect = async iterable => { const out = []; for await (const x of iterable) out.push(x); return out; };

test('a small write stays a single file and reads back', async t => {
  const base = path.join(tempDir(t), 'c', 'train.jsonl');
  assert.equal(jsonlExists(base), false);
  const result = await writeJsonlSharded(base, rows(5));
  assert.deepEqual(result.paths, [base]);
  assert.deepEqual(readJsonlShardedSync(base), rows(5));
  assert.deepEqual(await collect(readJsonlSharded(base)), rows(5));
});

test('a large write is split at line boundaries into bounded parts and replaces the stale single file', async t => {
  const base = path.join(tempDir(t), 'train.jsonl');
  writeJsonlShardedSync(base, rows(3));
  const result = await writeJsonlSharded(base, (async function* () { yield* rows(200); })(), {maxBytes: 1000});
  assert.ok(result.paths.length > 5);
  assert.equal(fs.existsSync(base), false);
  assert.deepEqual(shardPaths(base), result.paths);
  assert.match(path.basename(result.paths[0]), /^train\.part-000\.jsonl$/);
  for (const file of result.paths) {
    assert.ok(fs.statSync(file).size <= 1000);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  }
  assert.deepEqual(readJsonlShardedSync(base), rows(200));
  assert.deepEqual(readJSONL(base), rows(200), 'lib/util readJSONL follows shards');
  const again = writeJsonlShardedSync(base, rows(30), {maxBytes: 1000});
  assert.deepEqual(fs.readdirSync(path.dirname(base)).sort(), again.paths.map(p => path.basename(p)).sort(), 'stale higher parts removed');
  writeJsonlShardedSync(base, rows(2));
  assert.deepEqual(fs.readdirSync(path.dirname(base)), ['train.jsonl'], 'parts removed when the data fits again');
});

test('a row larger than the limit is rejected without leaving partial files', t => {
  const dir = tempDir(t), base = path.join(dir, 'big.jsonl');
  assert.throws(() => writeJsonlShardedSync(base, [{text: 'y'.repeat(200)}], {maxBytes: 100}), /larger than the 100-byte shard limit/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.throws(() => readJsonlShardedSync(base), /ENOENT/);
});

test('splitJsonlFile is byte-exact, keeps whole lines and reports malformed lines by part', async t => {
  const base = path.join(tempDir(t), 'src.jsonl');
  const text = rows(100).map(r => JSON.stringify(r)).join('\r\n') + '\r\n{"tail":true}';
  fs.writeFileSync(base, text);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const result = splitJsonlFile(base, {maxBytes: 700});
  assert.equal(result.sha256, sha);
  assert.equal(fs.existsSync(base), false);
  assert.equal(Buffer.concat(result.paths.map(p => fs.readFileSync(p))).toString(), text);
  assert.equal(await hashJsonlSharded(base), sha);
  assert.deepEqual(readJsonlShardedSync(base), [...rows(100), {tail: true}]);
  fs.appendFileSync(result.paths.at(-1), '\n{bad');
  assert.throws(() => readJsonlShardedSync(base), /part-\d{3}\.jsonl:\d+:/);
});
