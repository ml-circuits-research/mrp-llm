import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildInventory, OUT} from '../../tools/capabilities/inventory.mjs';
import {runCheck, compare, loadLedger} from '../../tools/capabilities/check.mjs';
import {ENGINES} from '../../tools/capabilities/l2-run.mjs';
import {coveringArray, compatible, FACTORS, program, renameEntities, splitRule, addIrrelevant} from '../../tools/capabilities/l2-generator.mjs';
import {circuitTags, modelTags} from '../../tools/capabilities/tags.mjs';
import {folCases, folCapabilities, runFolCases} from '../../tools/capabilities/l1-fol.mjs';

// The capability battery (owner request 2026-10-02): changing anything must never silently lose a capability. The inventory is derived
// from the grammar and the contracts; L1 validates every keyword (and runs the FOL converter's cases), L2 runs generated programs on every engine against the oracle, L3
// (formalization) is read from its last run. The gate fails when something that passed in the committed ledger no longer passes.

test('the committed capability inventory is the one the grammar and the contracts give (node tools/capabilities/inventory.mjs --write)', () => {
  const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const now = buildInventory();
  assert.deepEqual(committed.capabilities.map(c => c.id), now.capabilities.map(c => c.id), 'a wire type, field, enum value, word or validator code changed: regenerate the inventory');
  assert.deepEqual(committed.combinations.map(c => c.id), now.combinations.map(c => c.id));
});

test('the all-pairs grid covers every valid pair of factor levels and only valid rows', () => {
  const {rows} = coveringArray();
  assert.ok(rows.every(compatible));
  const names = Object.keys(FACTORS);
  const seen = new Set(rows.flatMap(r => names.flatMap((a, i) => names.slice(i + 1).map(b => `${a}=${r[a]}|${b}=${r[b]}`))));
  // every level of every factor appears with every level of the mode factor that the constraints allow
  for (const body of FACTORS.body) for (const def of FACTORS.def) assert.ok(seen.has(`body=${body}|def=${def}`), `body ${body} x def ${def}`);
});

test('metamorphic variants keep the program valid and change only what they claim', () => {
  const p = program({body: 'join', def: 'rule', rec: 'linear', num: 'integer', mode: 'select', time: 'none', supp: 'none', form: 'none', world: 'closed'}, 7);
  const r = renameEntities(p);
  assert.ok(!/\b(holds \w+ [a-e]\b)/.test(r.knowledge), 'every entity constant is renamed');
  assert.equal(Object.keys(r.map).length, 5);
  assert.match(addIrrelevant(p).knowledge, /noise_rel/);
  const s = splitRule(p);
  assert.ok(s && /aux_r_body/.test(s.knowledge), 'the two-condition rule is split through an auxiliary relation');
});

test('the tagger reads capabilities by parsing, on both surfaces', () => {
  const k = circuitTags({knowledge: '@p predicate\n  args subject:entity\n  closed true\n@q predicate\n  args subject:entity\n@r rule\n  when q ?x\n  when absent p ?x\n  then q ?x\n', query: '@q1 query\n  mode count\n  where q ?x\n  select ?x\n'});
  for (const t of ['k.wire.rule', 'k.leaf.absent', 'k.enum.query.mode.count', 'x.negation×closedness.absent.closed', 'k.feature.naf']) assert.ok(k.has(t), t);
  const m = modelTags('@s stated\n  relation "rain"\n  role subject "Paris"\n  polarity affirmed\n  certainty supposed\n\n@q query\n  where match\n    relation "be wet"\n    role subject "Paris"\n    polarity affirmed\n  end\n  mode exists\n  if $s\n');
  for (const t of ['m.wire.stated', 'm.enum.stated.certainty.supposed', 'm.field.query.if', 'x.link×certainty.if.supposed', 'm.enum.query.mode.exists']) assert.ok(m.has(t), t);
});

test('the gate reports a loss, a new wrong answer and a known one apart', () => {
  const ok = ENGINES.map(() => 'a').join('');
  const ledger = {l1: {c1: true, c2: false}, l2: {p1: {o: ok, m: 'a', oracle: 'supported'}, p2: {o: 'd' + ok.slice(1), m: null, oracle: 'supported'}}, l3: {}};
  const current = {l1: {c1: false, c2: false}, l1Got: {}, l2: {p1: {o: 'n' + ok.slice(1), m: 'd', oracle: 'supported'}, p2: {o: 'd' + ok.slice(2) + 'e', m: null, oracle: 'supported'}}, l2Detail: {}, l3: null};
  const {losses, failures, known} = compare(current, ledger);
  assert.deepEqual(losses.map(l => `${l.layer} ${l.id} ${l.engine ?? ''}`.trim()).sort(), ['L1 c1', `L2 p1 ${ENGINES[0]}`, 'L2 p1 metamorphic', `L2 p2 ${ENGINES.at(-1)}`].sort());
  assert.deepEqual(failures.map(f => `${f.id} ${f.engine}`), [`p2 ${ENGINES.at(-1)}`]);
  assert.ok(known.some(k => k.id === 'p2' && k.engine === ENGINES[0]) && known.some(k => k.id === 'c2'));
});

test('the converter family: every fol-v3 form and effect class has a case, and a wrong expectation fails (no model)', async () => {
  const {cases, missing} = folCases();
  assert.deepEqual(missing, [], 'a fol-v3 form or effect class has no case in eval/capabilities/fol-cases.json');
  for (const id of ['f.line.suppose', 'f.line.assume', 'f.question.effect', 'f.question.explain', 'f.question.missing', 'f.question.why', 'f.question.change', 'f.question.assumed', 'f.effect.blocks']) assert.ok(folCapabilities().includes(id), id);
  const base = cases.find(c => c.id === 'f:effect:establishes-and-no-effect');
  const wrongEffect = structuredClone(base);
  wrongEffect.id += ':wrong';
  wrongEffect.expect.answers[0].detail.effects[1].effect = 'blocks';
  const wrongRejected = {...structuredClone(base), id: base.id + ':rejected', expect: {...base.expect, rejected: ['not parsed']}};
  const r = await runFolCases([base, wrongEffect, wrongRejected]);
  assert.equal(r[base.id].pass, true, r[base.id].got);
  assert.equal(r[wrongEffect.id].pass, false);
  assert.match(r[wrongEffect.id].got, /circuit 1 detail/);
  assert.equal(r[wrongRejected.id].pass, false);
});

test('no capability loss: L1 and the fast L2 tier against the committed ledger', {timeout: 240000}, async () => {
  const ledger = loadLedger();
  assert.ok(ledger, 'eval/capabilities/ledger.json is missing: node tools/capabilities/check.mjs --tier full --update');
  const current = await runCheck({tier: 'fast'});
  assert.deepEqual(current.l1Missing, [], 'a keyword has no L1 sample: add one to tools/capabilities/l1.mjs');
  const {losses, failures} = compare(current, ledger);
  const show = xs => xs.slice(0, 12).map(x => `${x.layer} ${x.id}${x.engine ? ' [' + x.engine + ']' : ''}: ${typeof x.detail === 'string' ? x.detail : JSON.stringify(x.detail ?? '').slice(0, 240)}`).join('\n');
  assert.equal(failures.length, 0, 'new wrong answers or broken metamorphic relations:\n' + show(failures));
  assert.equal(losses.length, 0, 'capabilities lost against the ledger (fix them, or node tools/capabilities/check.mjs --tier full --update --accept-loss "<reason>"):\n' + show(losses));
});
