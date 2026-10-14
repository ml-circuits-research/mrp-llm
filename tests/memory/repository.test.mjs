import test from 'node:test';
import assert from 'node:assert/strict';
import {context, queryProgram, schema} from '../helpers.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {Repository} from '../../memory/repository.mjs';
import {RecallMemory} from '../../memory/weaver.mjs';

const add = '@f fact\n  holds likes ana lab_alpha\n  valid timeless\n@s remember\n  input $f';

/** Runs `body` against a fresh repository context and always disposes it. */
async function withContext(options, body) {
  const c = context(options);
  try {
    await body(c);
  } finally {
    c.dispose();
  }
}

const statusIn = async (repo, session, atom) => (await new Runtime({repo, session, schema}).run(queryProgram(atom))).result.status;

test('commit persists only for the same user', () => withContext({}, async c => {
  await c.run(add);
  c.repo.commit(c.session);
  const alice = c.repo.session('base', 'alice', 's2');
  const bob = c.repo.session('base', 'bob', 's2');
  assert.equal(await statusIn(c.repo, alice, 'likes ana lab_alpha'), 'supported');
  assert.equal(await statusIn(c.repo, bob, 'likes ana lab_alpha'), 'unknown');
}));

test('fork references the same immutable base snapshot', () => withContext({}, async c => {
  const a = c.repo.meta.bases.base;
  const b = c.repo.fork('base', 'forked');
  assert.equal(a, b);
}));

test('discard removes uncommitted changes', () => withContext({}, async c => {
  await c.run(add);
  c.repo.discard(c.session);
  assert.equal((await c.run(queryProgram('likes ana lab_alpha'))).result.status, 'unknown');
}));

test('stale session revisions do not overwrite newer writes', () => withContext({}, async c => {
  const stale = c.repo.session('base', 'alice', 's1');
  await c.run(add);
  assert.throws(() => c.repo.commit(stale), /Session changed/);
}));

test('frozen session does not adopt a later user commit automatically', () => withContext({}, async c => {
  const stale = c.repo.session('base', 'alice', 'frozen');
  await c.run(add);
  c.repo.commit(c.session);
  assert.equal(await statusIn(c.repo, stale, 'likes ana lab_alpha'), 'unknown');
}));

test('restart reconstructs tuple bodies without source journal', () => withContext({}, async c => {
  await c.run(add);
  c.repo.commit(c.session);
  const repo = new Repository(c.root);
  const s = repo.session('base', 'alice', 'restart');
  assert.equal(s.live.sources.length, 0);
  assert.equal(await statusIn(repo, s, 'likes ana lab_alpha'), 'supported');
}));

test('receipt checks are distinct from associative score', () => {
  const w = new RecallMemory({power: 7, verification: 'receipt'});
  w.add({p: 'parent', a: ['a', 'b']});
  const r = w.recall({p: 'parent', a: ['a', '?x']});
  assert.equal(r.rows[0].evidence.receipt, true);
  assert.equal(r.rows[0].evidence.support, 1);
});

test('pinned bank survives decay; forgotten is not explicitly false', () => withContext({bootstrap: false}, async c => {
  await c.run('@a fact\n  holds likes ana lab_alpha\n  valid timeless\n@b fact\n  holds likes ana lab_beta\n  valid timeless\n  retention pinned\n@s remember\n  input $a $b');
  c.repo.decay(c.session, 15);
  assert.equal((await c.run(queryProgram('likes ana lab_alpha'))).result.status, 'unknown');
  assert.equal((await c.run(queryProgram('likes ana lab_beta'))).result.status, 'supported');
}));

test('reobserving a normal claim as pinned promotes retention', () => withContext({bootstrap: false}, async c => {
  const text = '@f fact\n  holds likes ana lab_alpha\n  valid timeless\n  retention ';
  await c.run(text + 'normal\n@s remember\n  input $f');
  await c.run(text + 'pinned\n@s remember\n  input $f');
  c.session.live.decay(15);
  assert.equal((await c.run(queryProgram('likes ana lab_alpha'))).result.status, 'supported');
}));
