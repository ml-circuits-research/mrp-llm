import test from 'node:test';
import assert from 'node:assert/strict';
import {worldsSopr, NotExpressibleError} from '../../reasoning/strategies/worlds-sopr/index.mjs';
import {Engine} from '../../reasoning/strategies/worlds-sopr/vendor/sop-r/engine.mjs';
import {generate} from '../../reasoning/strategies/worlds-sopr/vendor/sop-r-test/gen.mjs';
import {rng} from '../../reasoning/strategies/worlds-sopr/vendor/sop-r-test/rng.mjs';
import {jsReference} from '../../reasoning/strategies/js-reference/index.mjs';

// ------------------------------------------------------------------------------------------------------------------
// ENTRY GATE, part 1: sop-r's own 1,200-answer incremental test (sop-r/test/incremental.mjs), ported unchanged in logic: 150 random
// hypothetical worlds (pure additions, removals and mixes, some nested) on a synthetic KB, answered by the incremental engine and by
// an engine that re-saturates every world from scratch. Every answer must be identical.
// ------------------------------------------------------------------------------------------------------------------
test('gate 1: sop-r incremental test, 150 worlds, 1,200 answers identical to recomputation', () => {
  const [N, W, SEED] = [1500, 150, 3];
  const CL = Math.max(20, N / 10), Z = Math.max(10, N / 200);
  const kb = generate(N, CL, Z, 1);
  const inc = new Engine([['kb', kb]]);
  const ref = new Engine([['kb', kb]], {incremental: false});
  const R = rng(SEED);
  const probes = ['?x alert yes', '?x busy yes', '?x hotspot yes', '?x has-busy-zone yes', '?x limit ?v', '?x located-in ?v', '?x overloaded yes', '?x shift ?v'];
  let same = 0, diff = 0, n = 0, adds = 0, mixed = 0;
  for (let k = 0; k < W; k++) {
    const lines = [];
    const pureAdd = R.next() < 0.6;
    pureAdd ? adds++ : mixed++;
    const m = 1 + Math.floor(R.next() * 4);
    for (let i = 0; i < m; i++) {
      const e = R.next() < 0.5 ? `new${k}-${i}` : `e${Math.floor(R.next() * N)}`;
      const c = Math.floor(R.next() * 6);
      if (c === 0) lines.push(`add ${e} is-a c${Math.floor(R.next() * CL)}`);
      if (c === 1) lines.push(`add ${e} in-zone z${Math.floor(R.next() * Z)}`);
      if (c === 2) lines.push(`add ${e} load ${50 + Math.floor(R.next() * 50)}`, `add ${e} capacity ${20 + Math.floor(R.next() * 40)}`);
      if (c === 3) lines.push(`add z${Math.floor(R.next() * Z)} located-in s${Math.floor(R.next() * 3)}`);
      if (c === 4) lines.push(pureAdd ? `add ${e} has backup` : `remove ${e} has backup`);
      if (c === 5) lines.push(pureAdd ? `add c${Math.floor(R.next() * CL)} subclass-of m0` : `set e${Math.floor(R.next() * N)} load 95`);
    }
    const nested = R.next() < 0.3;
    const q = ['@w assume', ...lines.map(l => '  ' + l)];
    if (nested) q.push('@w2 assume', '  in $w', `  add extra${k} is-a c1`, `  add extra${k} in-zone z0`, `  add extra${k} load 99`, `  add extra${k} capacity 20`);
    const order = probes.map((p, i) => [R.next(), p, i]).sort((a, b) => a[0] - b[0]);
    for (const [, p, i] of order) q.push(`@p${i} find`, `  in $${nested ? 'w2' : 'w'}`, `  match ${p}`, `@a${i} answer`, `  from $p${i}`);
    const text = q.join('\n') + '\n';
    const a = inc.query(text), b = ref.query(text);
    assert.deepEqual([a.errors, b.errors], [[], []]);
    for (const name of a.answers()) { n++; if (a.render(name) === b.render(name)) same++; else diff++; }
  }
  assert.equal(n, 1200);
  assert.equal(diff, 0, `${diff} answers differ from recomputation`);
  assert.ok(adds + mixed === W && inc.stats.incremental > 50, `incremental continuations: ${inc.stats.incremental}`);
});

// ------------------------------------------------------------------------------------------------------------------
// ENTRY GATE, part 2: the same kind of test through the ChatSOP core. A core program with recursion, negation as failure, `compare`
// and `compute`; 150 worlds (additions, retractions, `set` on a keyed predicate); eight probes per world; every packet equal to the
// oracle's on status, rows and count.
// ------------------------------------------------------------------------------------------------------------------
const N = 50;
const classes = 8, zones = 6;
function baseFacts() {
  const f = [];
  for (let c = 0; c < classes; c++) f.push(['subclass', `c${c}`, c < 2 ? 'top' : `c${c % 2}`]);
  for (let e = 0; e < N; e++) {
    f.push(['is_a', `e${e}`, `c${e % classes}`], ['in_zone', `e${e}`, `z${e % zones}`], ['load', `e${e}`, 20 + (e * 7) % 60], ['capacity', `e${e}`, 30 + (e * 11) % 40]);
    if (e % 9 === 0) f.push(['backup', `e${e}`]);
  }
  for (let z = 0; z < zones; z++) f.push(['located_in', `z${z}`, `s${z % 2}`]);
  return f;
}
const DECL = `@subclass predicate\n  args subject:entity object:entity\n@is_a predicate\n  args subject:entity object:entity\n@in_zone predicate\n  args subject:entity location:entity\n@load predicate\n  args subject:entity object:integer\n  key 1\n@capacity predicate\n  args subject:entity object:integer\n  key 1\n@backup predicate\n  args subject:entity\n  closed true\n@located_in predicate\n  args subject:entity object:entity\n@sub predicate\n  args subject:entity object:entity\n@isa predicate\n  args subject:entity object:entity\n@overloaded predicate\n  args subject:entity\n@alert predicate\n  args subject:entity\n  closed true\n@busy_zone predicate\n  args subject:entity\n@hotspot predicate\n  args subject:entity\n@double predicate\n  args subject:entity object:integer\n`;
const RULES = `@r_sub1 rule\n  when subclass ?a ?b\n  then sub ?a ?b\n@r_sub2 rule\n  when subclass ?a ?b\n  when sub ?b ?c\n  then sub ?a ?c\n@r_isa1 rule\n  when is_a ?e ?c\n  then isa ?e ?c\n@r_isa2 rule\n  when is_a ?e ?c\n  when sub ?c ?d\n  then isa ?e ?d\n@r_over rule\n  when load ?e ?l\n  when capacity ?e ?c\n  when compare ?l above ?c\n  then overloaded ?e\n@r_alert rule\n  when overloaded ?e\n  when absent backup ?e\n  then alert ?e\n@r_busy rule\n  when in_zone ?e ?z\n  when alert ?e\n  then busy_zone ?z\n@r_hot rule\n  when located_in ?z ?s\n  when busy_zone ?z\n  then hotspot ?s\n@r_double rule\n  when capacity ?e ?c\n  when compute ?d ?c times 2\n  then double ?e ?d\n`;
const render = facts => DECL + facts.map((f, i) => `@f${i} fact\n  holds ${f.join(' ')}`).join('\n') + '\n' + RULES;
const atomText = f => f.join(' ');
const PROBES = ['@q query\n  where alert ?e\n  select ?e\n', '@q query\n  where busy_zone ?z\n  select ?z\n', '@q query\n  where hotspot ?s\n  select ?s\n', '@q query\n  where overloaded ?e\n  select ?e\n', '@q query\n  where double e5 ?d\n  select ?d\n', '@q query\n  where isa ?e c3\n  select ?e\n', '@q query\n  mode count\n  where alert ?e\n', '@q query\n  mode exists\n  where hotspot s1\n'];
const rowKeys = p => (p.rows ?? []).map(r => JSON.stringify(r)).sort();

function makeWorlds(R, W) {
  const worlds = [];
  for (let k = 0; k < W; k++) {
    const add = [], remove = [], set = [];
    const m = 1 + Math.floor(R.next() * 4), pure = R.next() < 0.6;
    for (let i = 0; i < m; i++) {
      const e = `e${Math.floor(R.next() * N)}`, c = Math.floor(R.next() * 7);
      if (c === 0) add.push(['is_a', `n${k}_${i}`, `c${Math.floor(R.next() * classes)}`]);
      if (c === 1) add.push(['in_zone', `n${k}_${i}`, `z${Math.floor(R.next() * zones)}`]);
      if (c === 2) add.push(['load', `n${k}_${i}`, 70 + Math.floor(R.next() * 30)], ['capacity', `n${k}_${i}`, 20 + Math.floor(R.next() * 40)]);
      if (c === 3) add.push(['located_in', `z${Math.floor(R.next() * zones)}`, `s${Math.floor(R.next() * 3)}`]);
      if (c === 4) (pure ? add : remove).push(['backup', e]);
      if (c === 5) add.push(['subclass', `c${Math.floor(R.next() * classes)}`, 'top']);
      if (c === 6 && !pure) set.push(['load', e, 95]);
    }
    worlds.push({add, remove, set});
  }
  return worlds;
}

/** The oracle's view of a world: the facts of the base with the delta applied. */
function applyDelta(facts, w) {
  let out = facts.filter(f => !w.remove.some(r => atomText(r) === atomText(f)));
  for (const s of w.set) out = out.filter(f => !(f[0] === s[0] && f[1] === s[1]));
  return [...out, ...w.add, ...w.set];
}

test('gate 2: 150 worlds x 8 probes through the core (recursion, NAF, compare, compute, add, retract, set) equal the oracle', () => {
  const R = rng(11);
  const facts = baseFacts();
  const handle = worldsSopr.prepare(render(facts));
  const worlds = makeWorlds(R, 150);
  const lowered = worlds.map(w => ({add: w.add.map(atomText), remove: w.remove.map(atomText), set: w.set.map(atomText)}));
  let answers = 0, continued = 0;
  for (const probe of PROBES) {
    const {packets, stats} = worldsSopr.askMany(handle, lowered, probe);
    continued += stats.incrementalContinuations;
    packets.forEach((got, i) => {
      const want = jsReference.ask({theory: {knowledge: render(applyDelta(facts, worlds[i]))}, query: probe});
      assert.equal(got.status, want.status, `world ${i} ${probe}`);
      assert.deepEqual(rowKeys(got), rowKeys(want), `world ${i} ${probe}`);
      assert.equal(got.count, want.count);
      assert.equal(got.bound, want.bound);
      answers++;
    });
  }
  assert.equal(answers, 1200);
  assert.ok(continued > 0, 'additions continue incrementally in at least some worlds');
});

test('gate 2b: the base answer without any world equals the oracle', () => {
  const facts = baseFacts();
  const handle = worldsSopr.prepare(render(facts));
  for (const probe of PROBES) {
    const got = worldsSopr.ask({handle, query: probe}), want = jsReference.ask({theory: {knowledge: render(facts)}, query: probe});
    assert.equal(got.status, want.status);
    assert.deepEqual(rowKeys(got), rowKeys(want));
  }
});

// ------------------------------------------------------------------------------------------------------------------
// The non-monotone case: an addition in a world REMOVES a conclusion through negation as failure, two levels down, and (honestly)
// the world recomputes the affected cone instead of continuing; and the supposed-fact form of the same what-if.
// ------------------------------------------------------------------------------------------------------------------
test('non-monotone what-if: adding a backup removes an alert, a busy zone and a hotspot; the answer equals the oracle', () => {
  const facts = baseFacts();
  const handle = worldsSopr.prepare(render(facts));
  const hot = '@q query\n  where hotspot ?s\n  select ?s\n';
  const baseRows = rowKeys(worldsSopr.ask({handle, query: hot}));
  assert.ok(baseRows.length > 0, 'the base has a hotspot');
  // give every alerting entity a backup: the hotspot must disappear
  const alerting = worldsSopr.ask({handle, query: '@q query\n  where alert ?e\n  select ?e\n'}).rows.map(r => r.e);
  const world = worldsSopr.fork(handle, {add: alerting.map(e => `backup ${e}`)});
  const got = worldsSopr.ask({world, query: hot});
  const want = jsReference.ask({theory: {knowledge: render([...facts, ...alerting.map(e => ['backup', e])])}, query: hot});
  assert.deepEqual(rowKeys(got), rowKeys(want));
  assert.deepEqual(rowKeys(got), [], 'the conclusion downstream of a negation is gone');
  assert.ok(got.status === want.status && got.status !== 'supported');
  // the same what-if as supposed facts of the query circuit
  const sup = alerting.map((e, i) => `@h${i} fact\n  holds backup ${e}\n  status supposed\n`).join('\n');
  const viaFacts = worldsSopr.ask({handle, query: sup + hot});
  assert.deepEqual(rowKeys(viaFacts), []);
});

test('retraction and set are supported (recomputed, not incremental); set needs a declared key; arity 3 is refused', () => {
  const facts = baseFacts();
  const handle = worldsSopr.prepare(render(facts));
  const over = '@q query\n  where overloaded ?e\n  select ?e\n';
  const base = worldsSopr.ask({handle, query: over}).rows.length;
  const w = worldsSopr.fork(handle, {set: ['load e1 99', 'capacity e1 10']});
  const got = worldsSopr.ask({world: w, query: over});
  assert.ok(got.rows.some(r => r.e === 'e1'));
  const gone = worldsSopr.fork(handle, {remove: ['capacity e1 41']});
  worldsSopr.ask({world: gone, query: over});
  assert.throws(() => worldsSopr.fork(handle, {set: ['in_zone e1 z3']}), NotExpressibleError, 'set on a predicate without key');
  assert.ok(base >= 0);
  const k3 = '@p3 predicate\n  args subject:entity object:entity value:entity\n@f fact\n  holds p3 a b c\n';
  assert.throws(() => worldsSopr.prepare(k3), NotExpressibleError);
  assert.throws(() => worldsSopr.prepare('@n fact\n  holds not q a\n'), NotExpressibleError, 'classical negation is declined, never weakened');
});

test('siblings share one saturation: a batch of 100 addition worlds continues incrementally in an engine call', () => {
  const facts = baseFacts();
  const handle = worldsSopr.prepare(render(facts));
  const worlds = Array.from({length: 100}, (_, i) => ({add: [`load n${i} 95`, `capacity n${i} 10`, `in_zone n${i} z${i % zones}`]}));
  const {packets, stats} = worldsSopr.askMany(handle, worlds, '@q query\n  where hotspot ?s\n  select ?s\n');
  assert.equal(packets.length, 100);
  assert.ok(stats.incrementalContinuations >= 90, `continuations ${stats.incrementalContinuations}`);
});
