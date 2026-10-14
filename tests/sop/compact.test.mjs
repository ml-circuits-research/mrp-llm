import test from 'node:test';
import assert from 'node:assert/strict';
import {expandCompact, compactSource, hasCompact} from '../../sop/compact.mjs';
import {parse, canonical} from '../../sop/parser.mjs';
import {parse as parseKnowledge} from '../../sop/knowledge/lexical.mjs';

const CANONICAL = '@q query\n  where works_at ?who "Acme"\n  select ?who\n';

test('header pairs and indented pairs expand to canonical field lines, mixed with line fields', () => {
  const compact = '@q query select=?who\n  where works_at ?who "Acme"\n';
  assert.equal(expandCompact(compact), '@q query\n  select ?who\n  where works_at ?who "Acme"\n');
  assert.equal(expandCompact('@e entity name="Order 17" kind=order\n  owner=$c\n'), '@e entity\n  name "Order 17"\n  kind order\n  owner $c\n');
});

test('both surfaces parse to the same program', () => {
  const a = parse(CANONICAL), b = parse('@q query select=?who\n  where works_at ?who "Acme"');
  assert.deepEqual(a.wires.map(w => w.fields), b.wires.map(w => ({...w.fields})).map(f => ({where: f.where, select: f.select})));
  assert.equal(canonical(parse(canonical(b))).includes('select ?who'), true);
});

test('a canonical source is returned unchanged and is not flagged as compact', () => {
  assert.equal(hasCompact(CANONICAL), false);
  assert.equal(expandCompact(CANONICAL), CANONICAL);
});

test('a value with = inside a JSON string, and | blocks, are kept', () => {
  assert.equal(expandCompact('@n note text="a=b c"\n'), '@n note\n  text "a=b c"\n');
  const block = '@p procedure\n  body |\n    x=1\n    y=2\n  name=calc\n';
  assert.equal(expandCompact(block), '@p procedure\n  body |\n    x=1\n    y=2\n  name calc\n');
});

test('trailing header text that is not made of pairs stays for the parser to reject', () => {
  assert.throws(() => parse('@q query where works_at ?who\n  select ?who'), /expected @name type/);
});

test('compactSource renders single-term wires on one line and keeps multi-term wires canonical; both parse back', () => {
  const program = parse('@q query\n  where works_at ?who "Acme"\n  select ?who');
  const out = compactSource({wires: [{id: 'e', type: 'entity', fields: {name: ['"Ana"'], kind: ['person']}}, ...program.wires]});
  assert.match(out, /^@e entity name="Ana" kind=person$/m);
  assert.match(out, /^@q query\n {2}where works_at \?who "Acme"/m);
  assert.deepEqual(parse(out.split('\n\n')[1]).wires[0].fields, program.wires[0].fields);
});

test('the knowledge parser reads the compact surface too', () => {
  const a = parseKnowledge('@works_at predicate\n  arity 2\n'), b = parseKnowledge('@works_at predicate arity=2\n');
  assert.deepEqual(b.wires.map(w => [w.id, w.type]), a.wires.map(w => [w.id, w.type]));
  assert.deepEqual(b.errors, a.errors);
});
