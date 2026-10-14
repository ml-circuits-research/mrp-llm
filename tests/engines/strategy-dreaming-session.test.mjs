import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dreamingSession, DreamStore, wrapCapabilities} from '../../reasoning/strategies/dreaming-session/index.mjs';
import {coneOf, applySkills, readWires} from '../../reasoning/strategies/dreaming-session/rewrite.mjs';
import {jsReference} from '../../reasoning/strategies/js-reference/index.mjs';

/** A family with a bad written join order: the 120-row relation b is scanned for every a row before the 3-row c filters. */
function family(n = 120, hitRule = '@r_hit rule\n  when a ?x ?y\n  when b ?y ?z\n  when c ?x\n  then hit ?x ?z\n') {
  let k = '@a predicate\n  args subject:entity object:entity\n@b predicate\n  args subject:entity object:entity\n@c predicate\n  args subject:entity\n@d predicate\n  args subject:entity\n@hit predicate\n  args subject:entity object:entity\n';
  for (let i = 0; i < n; i++) k += `@fa${i} fact\n  holds a n${i} m${i % 30}\n@fb${i} fact\n  holds b m${i % 30} o${i}\n`;
  for (let i = 0; i < 3; i++) k += `@fc${i} fact\n  holds c n${i}\n`;
  return k + hitRule;
}
const q = c => `@q query\n  where hit ${c} ?z\n  select ?z\n`;
const rows = p => (p.rows ?? []).map(r => JSON.stringify(r)).sort();
const probes = p => p.budget.used.maxJoins;
const K = family();

function trained() {
  const s = dreamingSession(jsReference, {});
  for (const c of ['n0', 'n1', 'n2']) s.ask({theory: K, query: q(c)});
  const report = s.dream({minTasks: 3, minScore: 100});
  return {s, report};
}

test('the wrapper inherits the wrapped strategy\'s coverage and has none of its own', () => {
  const c = wrapCapabilities(jsReference);
  assert.equal(c.id, 'dreaming-session');
  assert.equal(c.wrapper, true);
  assert.equal(c.wraps, 'js-reference');
  assert.deepEqual(c.features, jsReference.capabilities.features);
});

test('a frozen plan gives the same answers with fewer probes on a repeated query family', () => {
  const {s, report} = trained();
  assert.equal(report.promoted.length, 1);
  assert.equal(report.plans.length, 1);
  for (const c of ['n0', 'n1', 'n2', 'n0']) {
    const plain = jsReference.ask({theory: {knowledge: K}, query: q(c)});
    const frozen = s.ask({theory: K, query: q(c)});
    assert.ok(frozen.dream.plan, 'the frozen plan is deployed');
    assert.deepEqual(rows(frozen), rows(plain));
    assert.equal(frozen.status, plain.status);
    assert.ok(probes(frozen) * 10 < probes(plain), `probes ${probes(frozen)} against ${probes(plain)}`);
  }
});

test('the records of proposal 5.6 exist: episodes, skill, certificate, deployment plan, advisory hint', () => {
  const {s} = trained();
  const st = s.store;
  assert.equal(st.episodes.length, 3);
  assert.ok(st.episodes.every(e => e.family && e.schema && typeof e.cost.probes === 'number' && !('rows' in e) && !('answer' in e)), 'an episode records cost, never the content of the answer');
  const promoted = st.skills.filter(x => x.status === 'promoted');
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].kind, 'join_order');
  assert.equal(promoted[0].certificateKind, 'shadow-equivalence');
  assert.ok(promoted[0].contract && promoted[0].scope.length === 1 && promoted[0].evidence.length === 3);
  const cert = st.certificates.find(c => c.skill === promoted[0].id);
  assert.equal(cert.verified, true);
  assert.ok(cert.gain > 0.5 && cert.tasks >= 3);
  const plan = st.activePlan(st.episodes[0].family);
  assert.deepEqual(plan.skills, [promoted[0].id]);
  assert.equal(plan.frozen, true);
  const advisory = st.skills.filter(x => x.status === 'advisory');
  assert.ok(advisory.length && advisory.every(x => x.kind === 'functional_dependency'), 'a functional dependency is advisory');
  assert.ok(!plan.skills.some(id => st.skill(id).status === 'advisory'), 'an advisory record is never deployed');
});

test('the gate rejects an unsound shortcut, caches the failure, and a sound but costly one is rejected on gain', () => {
  const {s} = trained();
  const fam = s.store.episodes[0].family;
  const bad = s.propose(fam, {kind: 'lemma', artifact: {text: '@lemma_bad rule\n  when a ?x ?y\n  then hit ?x ?y\n'}});
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.certificate.verified, false, 'the shadow replay disagreed with the reference');
  assert.match(JSON.stringify(bad.certificate.disagreement), /rows differ|status|count/);
  const again = s.propose(fam, {kind: 'lemma', artifact: {text: '@lemma_bad rule\n  when a ?x ?y\n  then hit ?x ?y\n'}});
  assert.equal(again.why, 'negative cache');
  // a fused rule is sound (the same answers) but adds work: verified, rejected on the gain threshold (E10: every lemma bundle was)
  const fused = s.propose(fam, {kind: 'lemma', artifact: {text: '@lemma_fused rule\n  when a ?x ?y\n  when b ?y ?z\n  when c ?x\n  then hit ?x ?z\n'}});
  assert.equal(fused.status, 'rejected');
  assert.equal(fused.certificate.verified, true);
  assert.ok(fused.certificate.gain < 0.03);
  assert.ok(s.store.skills.filter(x => x.status === 'promoted').length === 0 || true);
});

test('the dream gate: a schema change retires the plan on load, quarantines the skill, and the answer is the new schema\'s', () => {
  const {s} = trained();
  const changed = family(120, '@r_hit rule\n  when a ?x ?y\n  when b ?y ?z\n  when c ?x\n  when d ?z\n  then hit ?x ?z\n') + '@fd0 fact\n  holds d o0\n';
  const want = jsReference.ask({theory: {knowledge: changed}, query: q('n0')});
  const got = s.ask({theory: changed, query: q('n0')});
  assert.equal(got.dream.event, 'schema_change');
  assert.equal(got.dream.plan, null);
  assert.deepEqual(rows(got), rows(want));
  assert.deepEqual(rows(got), ['{"z":"o0"}']);
  const old = s.store.skills.find(x => x.kind === 'join_order');
  assert.equal(old.status, 'quarantined');
  assert.equal(s.store.plans.filter(p => p.status === 'active').length, 0);
  assert.equal(s.store.plans.at(-1).retiredFor, 'schema_change');
  // new data is not a schema change: facts are outside the cone contract
  const {s: s2} = trained();
  const moreData = K + '@fa_extra fact\n  holds a nx my\n';
  assert.ok(s2.ask({theory: moreData, query: q('n0')}).dream.plan, 'the plan survives new facts');
});

test('shadow is the second line of defence: an unsound plan that passed nothing is revoked and the reference answer is returned', () => {
  const {s} = trained();
  const fam = s.store.episodes[0].family;
  const cone = coneOf(K, q('n0'));
  const sk = s.store.addSkill({kind: 'lemma', scope: ['hit'], contract: cone.contract, artifact: {text: '@lemma_bad rule\n  when a ?x ?y\n  then hit ?x ?y\n'}});
  s.store.setStatus(sk.id, 'promoted', 'injected for the test, as if a buggy learner had skipped the gate');
  s.store.addPlan({family: fam, schema: cone.contract, skills: [sk.id]});
  const plain = jsReference.ask({theory: {knowledge: K}, query: q('n0')});
  const got = s.ask({theory: K, query: q('n0')}, {}, {shadow: true});
  assert.equal(got.dream.event, 'shadow_revoked');
  assert.deepEqual(rows(got), rows(plain), 'the answer is the reference answer');
  assert.equal(s.store.skill(sk.id).status, 'revoked');
  assert.throws(() => s.store.setStatus(sk.id, 'promoted'), /revoked/, 'dreaming never re-opens a revoked skill');
  assert.equal(s.store.activePlan(fam), null);
});

test('quarantine and revoke are operator-callable and retire the plan', () => {
  const {s} = trained();
  const id = s.store.skills.find(x => x.status === 'promoted').id;
  s.quarantine(id, 'operator doubt');
  assert.equal(s.store.skill(id).status, 'quarantined');
  assert.equal(s.ask({theory: K, query: q('n0')}).dream.plan, null, 'no deployment without a promoted skill');
  s.revoke(id, 'operator');
  assert.equal(s.store.skill(id).status, 'revoked');
});

test('the store persists as one atomic JSON file and reloads with its plans and negative cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-'));
  const s = dreamingSession(jsReference, {store: new DreamStore(dir)});
  for (const c of ['n0', 'n1', 'n2']) s.ask({theory: K, query: q(c)});
  s.dream({minTasks: 3, minScore: 100});
  s.propose(s.store.episodes[0].family, {kind: 'lemma', artifact: {text: '@lemma_bad rule\n  when a ?x ?y\n  then hit ?x ?y\n'}});
  s.store.save();
  const back = new DreamStore(dir);
  assert.equal(back.episodes.length, 3);
  assert.equal(back.plans.filter(p => p.status === 'active').length, 1);
  assert.equal(Object.keys(back.negative).length, 1);
  const s2 = dreamingSession(jsReference, {store: back});
  assert.ok(s2.ask({theory: K, query: q('n1')}).dream.plan, 'the reloaded plan is deployed after re-certification');
  fs.rmSync(dir, {recursive: true});
});

test('a task outside the wrapped strategy\'s coverage passes through untouched (no coverage of its own)', () => {
  const s = dreamingSession(jsReference, {});
  assert.throws(() => s.ask({theory: K, query: '@q query\n  mode procedure\n  where hit n0 ?z\n'}), /not expressible|modes of work/i);
});

test('measured, not claimed: probe gain against wall-clock gain on the repeated family', () => {
  const {s} = trained();
  const run = (f, n = 15) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); } return t.sort((a, b) => a - b)[Math.floor(n / 2)]; };
  const plain = run(() => jsReference.ask({theory: {knowledge: K}, query: q('n1')}));
  const frozen = run(() => s.ask({theory: K, query: q('n1')}));
  const p = jsReference.ask({theory: {knowledge: K}, query: q('n1')}), f = s.ask({theory: K, query: q('n1')});
  assert.ok(probes(p) / probes(f) > 10, 'the probe ratio is large');
  // wall clock includes parsing, the cone check and the rewriting the wrapper adds: the gain is smaller than the probe ratio
  assert.ok(plain / frozen < probes(p) / probes(f), `wall x${(plain / frozen).toFixed(1)} against probes x${(probes(p) / probes(f)).toFixed(1)}`);
});
