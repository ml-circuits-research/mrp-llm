// Repository file-size rule: no git-tracked or untracked-but-not-ignored file may exceed 50 MB (GitHub rejects
// files over 100 MB; the owner's limit is 50 MB). Large JSONL is sharded with lib/jsonl-shards.mjs and
// `node tools/shard-large-files.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {REPOSITORY_FILE_LIMIT} from '../../lib/jsonl-shards.mjs';
import {oversized} from '../../tools/shard-large-files.mjs';
import {repoPath} from '../helpers.mjs';

test('no repository file exceeds 50 MB', () => {
  const bad = oversized(REPOSITORY_FILE_LIMIT, [], repoPath(''));
  assert.deepEqual(bad.map(entry => `${entry.file} (${(entry.size / 1e6).toFixed(1)} MB)`), [],
    'Shard large JSONL with `node tools/shard-large-files.mjs`; move other large files out of the repository');
});
