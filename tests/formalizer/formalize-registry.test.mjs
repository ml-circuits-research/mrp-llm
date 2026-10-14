// The registry of a problem (lib/formalize/registry.mjs): numbers v1..vn extracted structurally with a context window, named things
// e1..ek kept only when the message writes them, and the prompt blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registry, withThings, renderRegistry, extractNumbers} from '../../lib/formalize/registry.mjs';

test('numbers: decimals, thousands separators and percentages in order; digits inside names are not numbers', () => {
  const n = extractNumbers('Plan A costs 4,000 per year plus 2.5% fees; room R2 seats 30 people for 1.5 hours.', {window: 3});
  assert.deepEqual(n.map(v => [v.name, v.value, v.percent]), [['v1', 4000, false], ['v2', 2.5, true], ['v3', 30, false], ['v4', 1.5, false]]);
  assert.equal(n[0].context, 'Plan A costs [4,000] per year plus');
});

test('things are copied from the message; a name the message does not write is dropped; the prompt blocks render by index', () => {
  const reg = withThings(registry('Option A takes 18 minutes. Option B takes 7 minutes. Which is faster?'), 'e1: Option A\nOption B\nOption C');
  assert.deepEqual(reg.things.map(t => [t.name, t.text]), [['e1', 'Option A'], ['e2', 'Option B']]);
  const blocks = renderRegistry(reg, {labels: new Map([[1, 'minutes | Option A']])});
  assert.equal(blocks.numbers, 'v1 = 18: minutes | Option A\nv2 = 7');
  assert.equal(blocks.things, 'e1 Option A, e2 Option B');
  assert.deepEqual(withThings(reg, 'none').things, []);
  assert.equal(withThings(reg, 'Option Z'), null);
});
