import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, canonical, validateGraph, dependencies, parseAtom} from '../../sop/parser.mjs';
import {lowerRule, lowerQuery, lowerConstraint} from '../../sop/lower.mjs';
import {schema} from '../helpers.mjs';

// Each invalid graph names the parser or validator guard that must reject it.
const invalidGraphs = {
  duplicate: ['@a value\n  data 1\n@a value\n  data 2', /Duplicate wire @a$/],
  badField: ['@a fact\n  holds parent ana bogdan\n  valid timeless\n  evil 1', /Unsupported field evil on fact$/],
  badIndent: ['@a value\n data 1', /Line 2: wire fields use two spaces$/],
  unknownType: ['@a systemExec\n  command ls', /Unknown wire type systemExec$/],
  // A legacy `$x` rule variable is read as a value reference, which does not exist.
  legacyVariable: ['@a rule\n  when parent $x $y\n  then parent $x $y', /Unknown reference x in @a$/],
  cycle: ['@a value\n  data $b\n@b value\n  data $a', /Cyclic value dependencies/],
  undefined: ['@a value\n  data $missing', /Unknown reference missing in @a$/],
  reserved: ['@constructor value\n  data 1', /Reserved wire name$/],
};
for (const [name, [source, message]] of Object.entries(invalidGraphs)) {
  test('reject ' + name, () => {
    assert.throws(() => validateGraph(parse(source)), message);
  });
}

test('logical variables do not create dependencies', () => {
  const w = parse('@r rule\n  when parent ?x ?y\n  then ancestor ?x ?y').wires[0];
  assert.deepEqual(dependencies(w), {values: [], handles: []});
  lowerRule(w, {}, schema);
});

test('quoted dollar and tilde are text', () => {
  assert.deepEqual(dependencies(parse('@v value\n  data "$ignored ~text"').wires[0]), {values: [], handles: []});
});

test('forward references are topologically ordered', () => {
  assert.deepEqual(validateGraph(parse('@b value\n  data $a + 1\n@a value\n  data 2')), ['a', 'b']);
});

test('canonical roundtrip', () => {
  const s = '@q query\n  mode select\n  select ?x\n  where parent ?x "Bogdan, Jr."\n  during 2025-01-01 2026-01-01';
  const a = parse(s);
  assert.equal(canonical(parse(canonical(a))), canonical(a));
});

test('predicate and argument strings are data', () => {
  assert.deepEqual(parseAtom('not likes ana "a,b"'), {p: 'likes', a: ['ana', 'a,b'], neg: true});
});

test('unsafe rule is rejected', () => {
  const wire = parse('@r rule\n  when parent ?x ?y\n  then parent ?x ?z').wires[0];
  assert.throws(() => lowerRule(wire, {}, schema), /Unsafe head variable/);
});

test('unknown predicate is not invented', () => {
  const wire = parse('@q query\n  where magic ana').wires[0];
  assert.throws(() => lowerQuery(wire, {}, schema), /Unknown predicate magic/);
});

test('unbound query output rejected', () => {
  const wire = parse('@q query\n  mode select\n  select ?z\n  where parent ?x ?y').wires[0];
  assert.throws(() => lowerQuery(wire, {}, schema), /Unbound selected variable/);
});

test('nonlinear multiplication rejected', () => {
  const wire = parse('@c constraint\n  var ?x int 0 3\n  var ?y int 0 3\n  claim ?x * ?y > 0').wires[0];
  assert.throws(() => lowerConstraint(wire), /Only constant multiplication is in the portable constraint profile/);
});

test('temporal endpoints not guessed', () => {
  const wire = parse('@q query\n  where parent ana bogdan\n  at 2025').wires[0];
  assert.throws(() => lowerQuery(wire, {}, schema), /Use ISO date or UTC timestamp: 2025/);
});

test('resolve has a typed literal surface and predicate heads cannot be dynamic', () => {
  assert.deepEqual(
    validateGraph(parse('@name resolve\n  text "Alpha Lab"\n  language en\n  kind entity\n  type organization\n@q query\n  where works_at maria $name')),
    ['name', 'q'],
  );
  assert.throws(() => parse('@name resolve\n  text "works at"\n  language en\n  kind predicate\n@q query\n  where $name maria lab_alpha'), /Expected/);
  assert.throws(() => parse('@name resolve\n  text "bank"\n  language en\n  kind predicate\n  type organization'), /only for entities/);
});

test('remember is an explicit session operation; legacy assert is not a wire type', () => {
  assert.equal(parse('@f fact\n  holds likes ana book\n  valid timeless\n@s remember\n  input $f').wires.at(-1).type, 'remember');
  assert.throws(() => parse('@s assert\n  input $f'), /Unknown wire type/);
});
