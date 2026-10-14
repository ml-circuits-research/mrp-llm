/** Host frame and synonym normalization (sop/frames.mjs, owner answer to Q-SYM-2): synonyms, single-oblique role
 * relabeling, relation/object boundary shifts and quoted times, on inline frames and on the configured list. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../sop/parser.mjs';
import {parseFrames, formatFrames, Frames, normalizeProposition, normalizeProgram, loadFrames} from '../../sop/frames.mjs';

const FRAMES = new Frames([
  {id: 'world:wants_to_learn', relation: 'want to learn', roles: ['subject', 'topic'], surfaces: ['plan to study'], source: 'world'},
  {id: 'world:flu_shot', relation: 'get the flu shot', roles: ['subject'], surfaces: [], source: 'world'},
  {id: 'world:borrowed', relation: 'borrow', roles: ['subject', 'object'], surfaces: [], source: 'world'},
  {id: 'world:moves', relation: 'move', roles: ['subject', 'source', 'destination'], surfaces: [], source: 'world'},
  {id: 'world:studies_at', relation: 'study at', roles: ['subject', 'object'], surfaces: ['go to'], source: 'world'},
  {id: 'world:attended', relation: 'attend', roles: ['subject', 'object'], surfaces: ['go to'], source: 'world'},
]);
const p = (relation, ...roles) => ({relation, roles: roles.map(([name, value]) => ({name, value}))});

test('frames TSV round-trips and rejects roles outside the DS014 inventory', () => {
  const text = formatFrames([{id: 'x:a', relation: 'work at', roles: ['subject', 'object'], surfaces: ['work for'], source: 'world', note: 'n'}]);
  assert.deepEqual(parseFrames(text)[0].surfaces, ['work for']);
  assert.throws(() => parseFrames('id\trelation\troles\tsurfaces\tsource\tnote\nx:a\twork at\tsubject|employer\t\t\t\n'), /DS014 inventory/);
});

test('a synonym becomes the canonical relation and a single undeclared role is relabeled', () => {
  const out = normalizeProposition(p('plan to study', ['subject', '"Ana"'], ['object', '"history"']), FRAMES);
  assert.equal(out.relation, 'want to learn');
  assert.deepEqual(out.roles.map(r => r.name), ['subject', 'topic']);
  assert.deepEqual(out.changes.map(c => c.kind), ['synonym', 'role']);
});

test('frames that share one role set fix the role name although the relation stays ambiguous', () => {
  const out = normalizeProposition(p('go to', ['subject', '"Ana"'], ['destination', '"Arad College"']), FRAMES);
  assert.equal(out.relation, 'go to');
  assert.equal(out.roles[1].name, 'object');
});

test('two undeclared roles are never relabeled', () => {
  const out = normalizeProposition(p('move', ['subject', '"Ana"'], ['location', '"Cluj"'], ['object', '"Iași"']), FRAMES);
  assert.deepEqual(out.roles.map(r => r.name), ['subject', 'location', 'object']);
});

test('the relation/object boundary shifts in both directions when that names a frame', () => {
  const joined = normalizeProposition(p('get', ['subject', '"Yan"'], ['object', '"the flu shot"']), FRAMES);
  assert.equal(joined.relation, 'get the flu shot');
  assert.deepEqual(joined.roles.map(r => r.name), ['subject']);
  const split = normalizeProposition(p('borrow soups of', ['subject', '"Csaba"'], ['object', '"Transylvania"']), FRAMES);
  assert.equal(split.relation, 'borrow');
  assert.equal(split.roles.find(r => r.name === 'object').value, '"soups of Transylvania"');
  const levels = normalizeProposition(p('get', ['subject', '"Yan"'], ['object', '"the flu shot"']), FRAMES, {levels: ['synonym', 'role']});
  assert.equal(levels.relation, 'get');
});

test('a program is rewritten line by line; a quoted time moves to validity or the query period', () => {
  const sop = '@s1 stated\n  relation "arrive"\n  role subject "the cleaners"\n  role time "11"\n  polarity affirmed\n  certainty asserted\n\n@q query\n  where match\n    relation "get"\n    role subject "Yan"\n    role object "the flu shot"\n    polarity affirmed\n  end\n';
  const out = normalizeProgram(sop, FRAMES);
  assert.match(out.sop, /valid on "11"/);
  assert.doesNotMatch(out.sop, /role time/);
  assert.match(out.sop, /relation "get the flu shot"/);
  assert.doesNotMatch(out.sop, /role object "the flu shot"/);
  assert.equal(parse(out.sop).wires.length, 2);
  assert.deepEqual(out.changes.map(c => c.kind).sort(), ['boundary', 'time']);
});

test('the configured list covers the training world, holds English surfaces only and does not read Romanian', () => {
  const frames = loadFrames();
  assert.ok(frames.frames.filter(f => f.source === 'world').length >= 70);
  assert.ok(frames.frames.every(f => ![f.relation, ...f.surfaces].some(surface => /[ăâîșț]/i.test(surface))), 'no Romanian surface in the frames');
  const out = normalizeProposition(p('vrea învăța', ['subject', '"Ana"'], ['object', '"chimie"']), frames);
  assert.equal(out.relation, 'vrea învăța', 'a Romanian relation is not normalized by the core');
});
