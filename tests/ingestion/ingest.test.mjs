import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareKnowledge, publishKnowledge} from '../../sop/ingest.mjs';
import {context, schema, day} from '../helpers.mjs';

const source = 'Maria lucrează la Alfa din 2024.';
const sop = '@f fact\n  holds works_at maria lab_alpha\n  valid 2024-01-01 open\n  source doc\n  quote "Maria lucrează la Alfa din 2024."';

test('reviewed sourced SOP imports with exact quote', () => {
  const r = prepareKnowledge(sop, {schema, reviewed: true, documents: {doc: source}, requireQuotes: true});
  assert.equal(Object.keys(r.layer.claims).length, 1);
});

test('missing or invented quote rejected', () => {
  assert.throws(
    () => prepareKnowledge(sop, {schema, reviewed: true, documents: {doc: 'Alt text'}, requireQuotes: true}),
    /Quote is not an exact source span/,
  );
});

test('import does not execute arbitrary top-level wires', () => {
  assert.throws(
    () => prepareKnowledge('@x jsEval\n  expr 1+1', {schema, reviewed: true}),
    /Ingestion accepts fact\/rule\/template definitions, not executable effects/,
  );
});

test('historic library selection happens before ID deduplication', () => {
  const c = context({bootstrap: false});
  try {
    const s = '@r rule\n  when mother ?x ?y\n  then parent ?x ?y';
    publishKnowledge(c.repo, 'base', s, {schema, reviewed: true, knownAt: day('2024-01-01')});
    publishKnowledge(c.repo, 'base', s.replace('mother ?x', 'father ?x'), {schema, reviewed: true, knownAt: day('2026-01-01')});
    const session = c.repo.session('base', 'new', 'historical');
    assert.match(c.repo.library(session, {asof: day('2025-01-01')})[0].sop, /mother/);
    assert.match(c.repo.library(session)[0].sop, /father/);
  } finally {
    c.dispose();
  }
});

test('correction cannot bypass pinning policy', async () => {
  const c = context({bootstrap: false});
  try {
    const s = await c.run(sop + '\n@s remember\n  input $f');
    const correction = '@f fact\n  holds works_at maria lab_beta\n  valid timeless\n  retention pinned\n@e event\n  action correct\n  target "' + s.result.ids[0] + '"\n  replacement $f\n@s remember\n  input $e';
    await assert.rejects(() => c.run(correction, {policy: {allowPin: false}}), /Pinning/);
  } finally {
    c.dispose();
  }
});
