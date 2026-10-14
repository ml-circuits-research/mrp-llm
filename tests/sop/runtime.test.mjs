import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Runtime} from '../../sop/runtime.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {context, schema, lex, queryProgram} from '../helpers.mjs';

const example = name => fs.readFileSync(new URL(`../../examples/${name}`, import.meta.url), 'utf8');

/** Runs `body` against a fresh repository context and always disposes it. */
async function withContext(options, body) {
  const c = context(options);
  try {
    await body(c);
  } finally {
    c.dispose();
  }
}

test('local SOP executes Horn rules', async () => {
  const r = await new Runtime({schema}).run(example('local.sop'));
  assert.equal(r.result.packet.answers[0].binding['?who'], 'ana');
});

test('retrieve missing rule-body predicates before deriving answer', () => withContext({}, async c => {
  const r = await c.run(example('query.sop'));
  assert.equal(r.values.r.answers[0].binding['?who'], 'ana');
  assert.ok(r.values.m.needed.includes('parent'));
  assert.ok(r.values.m.needed.includes('mother'));
}));

test('mixed memory to numeric solver path', () => withContext({}, async c => {
  const r = await c.run(example('mixed.sop'));
  assert.equal(r.values.duration, 70);
  assert.equal(r.result.packet.status, 'possible');
}));

test('approved template expands into separate SSA names', () => withContext({}, async c => {
  const r = await c.run(example('expand.sop'));
  assert.equal(r.epochs, 2);
  assert.equal(r.result.packet.answers.length, 2);
  assert.ok(r.trace.some(x => x.wire === 'answer__q'));
}));

test('epoch budget is enforced', () => withContext({}, async c => {
  await assert.rejects(c.run(example('expand.sop'), {policy: {maxEpochs: 0}}), /epoch budget/);
}));

test('hypothesis never contaminates persistent memory', () => withContext({}, async c => {
  const r = await c.run(example('hypothesis.sop'));
  assert.equal(r.result.packet.hypothetical, true);
  const after = await c.run(queryProgram('parent carina person_delta'));
  assert.equal(after.result.status, 'unknown');
}));

test('read-only policy refuses explicit session remember', () => withContext({}, async c => {
  const write = '@f fact\n  holds parent ana carina\n  valid timeless\n@s remember\n  input $f';
  await assert.rejects(c.run(write, {policy: {allowWrite: false}}), /Writes are disabled/);
  assert.equal((await c.run(queryProgram('parent ana carina'))).result.status, 'unknown');
}));

test('model output cannot install rules', () => withContext({}, async c => {
  const runtime = new Runtime({repo: c.repo, session: c.session, schema});
  await assert.rejects(
    runtime.run('@r rule\n  when parent ?x ?y\n  then likes ?x ?y', {origin: 'model'}),
    /Model authors stated, assumed, unclear, query, constraint, unparsed, pragmatic or instruction; rule belongs to symbolic execution/,
  );
}));

test('independent writes batch one revision', () => withContext({bootstrap: false}, async c => {
  const r = await c.run('@a fact\n  holds parent ana bogdan\n  valid timeless\n@b fact\n  holds parent bogdan carina\n  valid timeless\n@x remember\n  input $a\n@y remember\n  input $b');
  assert.equal(c.session.revision, 1);
  assert.equal(r.values.x.revision, r.values.y.revision);
}));

test('foreign target causes whole effect batch to fail', () => withContext({bootstrap: false}, async c => {
  await assert.rejects(
    c.run('@a fact\n  holds parent ana bogdan\n  valid timeless\n@e event\n  action retract\n  target "c_00000000000000000000000000000000"\n@x remember\n  input $a $e'),
    /Cannot update an unknown\/nonvisible claim/,
  );
  assert.equal(Object.keys(c.session.live.claims).length, 0);
}));

test('a fact declaration alone does not record a session claim', () => withContext({}, async c => {
  await c.run('@a fact\n  holds parent ana carina\n  valid timeless');
  assert.equal((await c.run(queryProgram('parent ana carina'))).result.status, 'unknown');
}));

test('assumption facts support a query only through assume and cannot be remembered as verified facts', () => withContext({bootstrap: false}, async c => {
  const source = '@p fact\n  holds likes ana lab_alpha\n  valid timeless\n  source assumption\n@s query\n  where likes ana lab_alpha\n@answer solve\n  query $s\n  assume $p';
  const r = await c.run(source);
  assert.equal(r.result.status, 'supported');
  assert.equal(r.result.hypothetical, true);
  assert.equal((await c.run(queryProgram('likes ana lab_alpha'))).result.status, 'unknown');
  await assert.rejects(
    c.run('@p fact\n  holds likes ana lab_alpha\n  valid timeless\n  source assumption\n@s remember\n  input $p'),
    /assumption_fact_unconsumed/,
  );
  assert.equal(Object.keys(c.session.live.claims).length, 0);
}));

test('planning retrieves future-state requirements and their rule dependencies without writing', () => withContext({bootstrap: false, memory: {engine: 'sqlite'}}, async c => {
  const setup = '@position fact\n  holds located_in robot a\n  valid timeless\n@road_ab fact\n  holds connected a b\n  valid timeless\n@road_bc fact\n  holds connected b c\n  valid timeless\n@stored remember\n  input $position $road_ab $road_bc';
  await c.run(setup, {schema: null});
  const revision = c.session.revision;
  const plan = '@can_travel rule\n  when located_in ?r ?from\n  when connected ?from ?to\n  then can_travel ?r ?from ?to\n@move action\n  params ?r ?from ?to\n  requires located_in ?r ?from\n  requires can_travel ?r ?from ?to\n  removes located_in ?r ?from\n  adds located_in ?r ?to\n@destination goal\n  where located_in robot c\n@result plan\n  goal $destination\n  actions ~move\n  data ~can_travel';
  const run = options => c.run(plan, {schema: null, policy: {retrievalStrategy: 'sqlite', ...options}});
  const found = (await run()).result;
  assert.equal(found.status, 'plan_found');
  assert.equal(found.complete, true);
  assert.equal(found.plan.cost, 2);
  assert.equal(c.session.revision, revision);

  const bounded = (await run({maxFacts: 1})).result;
  assert.equal(bounded.status, 'budget_exhausted');
  assert.equal(bounded.reason, 'partial_retrieval');
  assert.equal(bounded.complete, false);
  assert.equal(c.session.revision, revision);
}));

test('entity resolve creates a typed consumable temporary symbol for local query', async () => {
  const source = '@company resolve\n  text "Alpha Lab"\n  language en\n  kind entity\n  type organization\n@f fact\n  holds works_at maria lab_alpha\n  valid timeless\n@q query\n  where works_at maria $company\n@r reason\n  query $q\n  data $f';
  const result = await new Runtime({schema, lexicon: lex}).run(source);
  assert.equal(result.values.company, 'lab_alpha');
  assert.equal(result.outputs.company.type, 'organization');
  assert.equal(result.outputs.company.version, lex.version);
  assert.equal(result.result.status, 'supported');
});

test('unresolved identity blocks dependent query rather than making a fact', async () => {
  const l = new Lexicon('@alpha entity\n  kind person\n  label en "bank"\n@beta entity\n  kind person\n  label en "bank"\n@has predicate\n  args person\n  label en "has"');
  for (const [name, status] of [['bank', 'ambiguous'], ['unlisted', 'unknown']]) {
    const r = await new Runtime({schema: l.predicates, lexicon: l}).run(`@who resolve\n  text "${name}"\n  language en\n  kind entity\n@q query\n  where has $who`);
    assert.equal(r.outputs.who.status, status);
    assert.equal(r.blocked.q.status, 'blocked');
    assert.equal(r.values.q, undefined);
  }
});

test('runtime checks resolved entity type and refuses predicate as atom argument', async () => {
  const runtime = new Runtime({schema, lexicon: lex});
  await assert.rejects(runtime.run('@who resolve\n  text "Alpha Lab"\n  language en\n  kind entity\n@q query\n  where works_at $who lab_alpha'), /entity type/);
  await assert.rejects(runtime.run('@what resolve\n  text "works at"\n  language en\n  kind predicate\n@q query\n  where likes maria $what'), /Only entity resolution/);
});
