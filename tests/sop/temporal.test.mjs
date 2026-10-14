import test from 'node:test';
import assert from 'node:assert/strict';
import {context, queryProgram, day} from '../helpers.mjs';
import {instant} from '../../lib/time.mjs';

const add = '@f fact\n  holds works_at ana lab_alpha\n  valid 2024-01-01 2025-06-01\n@s remember\n  input $f';

/** Runs `body` against a fresh repository context and always disposes it. */
async function withContext(options, body) {
  const c = context(options);
  try {
    await body(c);
  } finally {
    c.dispose();
  }
}

const statusOf = async (c, atom, options) => (await c.run(queryProgram(atom, options))).result.status;

for (const [date, status] of [['2023-12-31', 'unknown'], ['2024-01-01', 'supported'], ['2025-05-31', 'supported'], ['2025-06-01', 'unknown']]) {
  test('half-open boundary ' + date, () => withContext({}, async c => {
    await c.run(add);
    assert.equal(await statusOf(c, 'works_at ana lab_alpha', '  at ' + date), status);
  }));
}

test('invalid calendar date rejected', () => {
  assert.throws(() => instant('2025-02-30'), /Invalid calendar date/);
});

test('new employment does not erase another job', () => withContext({}, async c => {
  await c.run('@f fact\n  holds works_at maria lab_beta\n  valid 2025-01-01 open\n@s remember\n  input $f');
  const r = await c.run(queryProgram('works_at maria ?org', '  mode select\n  select ?org\n  at 2026-01-01'));
  assert.equal(r.result.answers.length, 2);
}));

test('end event affects effective time, asof preserves earlier knowledge', () => withContext({bootstrap: false}, async c => {
  const s = await c.run('@f fact\n  holds works_at ana lab_alpha\n  valid 2024-01-01 open\n@s remember\n  input $f', {now: day('2024-02-01')});
  const id = s.result.ids[0];
  await c.run('@e event\n  action end\n  target "' + id + '"\n  effective 2025-06-01\n@s remember\n  input $e', {now: day('2026-01-01')});
  assert.equal(await statusOf(c, 'works_at ana lab_alpha', '  at 2025-07-01\n  asof 2025-08-01'), 'supported');
  assert.equal(await statusOf(c, 'works_at ana lab_alpha', '  at 2025-07-01\n  asof 2026-02-01'), 'unknown');
}));

test('epistemic correction retracts earlier claim only after learned date', () => withContext({bootstrap: false}, async c => {
  const s = await c.run('@f fact\n  holds works_at ana lab_alpha\n  valid 2024-01-01 open\n@s remember\n  input $f', {now: day('2024-02-01')});
  await c.run('@f fact\n  holds works_at ana lab_beta\n  valid 2024-01-01 open\n@e event\n  action correct\n  target "' + s.result.ids[0] + '"\n  replacement $f\n@s remember\n  input $e', {now: day('2025-01-01')});
  assert.equal(await statusOf(c, 'works_at ana lab_alpha', '  at 2024-06-01\n  asof 2024-06-01'), 'supported');
  assert.equal(await statusOf(c, 'works_at ana lab_alpha', '  at 2024-06-01\n  asof 2026-01-01'), 'unknown');
  assert.equal(await statusOf(c, 'works_at ana lab_beta', '  at 2024-06-01\n  asof 2026-01-01'), 'supported');
}));

test('nonoverlapping facts cannot produce a temporal conclusion', () => withContext({}, async c => {
  const r = await c.run([
    '@a fact',
    '  holds parent ana bogdan',
    '  valid 2024-01-01 2025-01-01',
    '@b fact',
    '  holds parent bogdan carina',
    '  valid 2025-01-01 2026-01-01',
    '@rule rule',
    '  when parent ?x ?y',
    '  when parent ?y ?z',
    '  then grandparent ?x ?z',
    '@d pack',
    '  items $a $b $rule',
    '@q query',
    '  where grandparent ana carina',
    '  during 2024-01-01 2026-01-01',
    '@r reason',
    '  query $q',
    '  data $d',
  ].join('\n'));
  assert.equal(r.result.status, 'unknown');
}));

test('explicit negation produces conflict, not explosion', () => withContext({}, async c => {
  await c.run('@a fact\n  holds parent ana bogdan\n  valid timeless\n@b fact\n  holds not parent ana bogdan\n  valid timeless\n@s remember\n  input $a $b');
  assert.equal(await statusOf(c, 'parent ana bogdan'), 'both');
  assert.equal(await statusOf(c, 'likes ana lab_beta'), 'unknown');
}));

test('local facts outside query instant cannot support a point query', () => withContext({}, async c => {
  const r = await c.run('@f fact\n  holds likes ana lab_alpha\n  valid 2024-01-01 2025-01-01\n@d pack\n  items $f\n@q query\n  where likes ana lab_alpha\n  at 2026-01-01\n@r reason\n  query $q\n  data $d');
  assert.equal(r.result.status, 'unknown');
}));

test('a rule outside the requested instant cannot derive a current conclusion', () => withContext({}, async c => {
  const r = await c.run([
    '@f fact',
    '  holds mother ana bogdan',
    '  valid timeless',
    '@rule rule',
    '  when mother ?x ?y',
    '  then parent ?x ?y',
    '  valid 2024-01-01 2025-01-01',
    '@d pack',
    '  items $f $rule',
    '@q query',
    '  where parent ana bogdan',
    '  at 2026-01-01',
    '@r reason',
    '  query $q',
    '  data $d',
  ].join('\n'));
  assert.equal(r.result.status, 'unknown');
}));

test('sequential positive and negative states are not a contradiction', () => withContext({}, async c => {
  const r = await c.run([
    '@f fact',
    '  holds likes ana lab_alpha',
    '  valid 2024-01-01 2025-01-01',
    '@n fact',
    '  holds not likes ana lab_alpha',
    '  valid 2025-01-01 2026-01-01',
    '@d pack',
    '  items $f $n',
    '@q query',
    '  where likes ana lab_alpha',
    '  during 2024-01-01 2026-01-01',
    '@r reason',
    '  query $q',
    '  data $d',
  ].join('\n'));
  assert.equal(r.result.status, 'mixed_temporal');
}));
