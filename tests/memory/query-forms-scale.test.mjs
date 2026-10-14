// Counts, superlatives, ordinals, comparative choices and derived measures expressed as knowledge-wire query circuits and executed over a
// large SQLite memory through the product path (reasoning/slice askMemory): exact when the slice settles, `incomplete` (never the best of
// a part) when it cannot, and retrieval that stays small when a comparison names the candidates. The memory has 3000 cities in 60 countries
// on 6 continents and 3000 people with birth and death years; the rules are the transitive `located_in` and the derived `lived_years`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Repository} from '../../memory/repository.mjs';
import {ingestFacts} from '../../lib/chat-data/memories.mjs';
import {Theory, askMemory} from '../../reasoning/slice/index.mjs';

const KNOWN = Date.parse('2024-01-01');
const fact = (p, ...t) => `@f_${p}_${t.join('_')} fact\n  holds ${p} ${t.join(' ')}\n`;
const pred = (id, args) => `@${id} predicate\n  args ${args}\n`;
const CONTINENTS = ['europe', 'asia', 'africa', 'oceania', 'americas', 'antarctica'];
const countryContinent = i => CONTINENTS[i % 6];
const cityCountry = i => i % 60;
const cityPopulation = i => 1000 + ((i * 7919) % 100003);        // distinct for every city
const countryArea = i => 5000 + ((i * 104729) % 90001);          // distinct for every country
const born = i => 1500 + (i % 400), died = i => born(i) + 20 + ((i * 31) % 70);

function build() {
  let c = pred('is_a', 'entity entity') + pred('located_in', 'entity entity') + pred('area_of', 'entity integer') + pred('population_of', 'entity integer')
    + pred('born_on', 'entity integer') + pred('died_on', 'entity integer') + pred('lived_years', 'entity integer');
  c += '@r_trans rule\n  when located_in ?a ?b\n  when located_in ?b ?c\n  then located_in ?a ?c\n';
  c += '@r_lived rule\n  when born_on ?p ?b\n  when died_on ?p ?d\n  when compute ?n ?d minus ?b\n  then lived_years ?p ?n\n';
  for (let i = 0; i < 60; i++) c += fact('is_a', 'country' + i, 'country') + fact('located_in', 'country' + i, countryContinent(i)) + fact('area_of', 'country' + i, countryArea(i));
  for (let i = 0; i < 3000; i++) c += fact('is_a', 'city' + i, 'city') + fact('located_in', 'city' + i, 'country' + cityCountry(i)) + fact('population_of', 'city' + i, cityPopulation(i));
  for (let i = 0; i < 3000; i++) c += fact('born_on', 'person' + i, born(i)) + fact('died_on', 'person' + i, died(i));
  return c;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-scale-'));
const repo = new Repository(root, {memory: {engine: 'sqlite'}});
const circuit = build();
const wires = circuit.split(/\n(?=@)/);
for (let i = 0; i < wires.length; i += 1000) ingestFacts(repo, 'base', wires.slice(i, i + 1000).join('\n') + '\n', {knownAt: KNOWN});
const session = repo.session('base', 'alice', 's1');
const theory = new Theory([{name: 'circuit', text: circuit}]);
const ask = (query, limits = {}, budget = {maxJoins: 40_000_000, maxFacts: 2_000_000, timeoutMs: 120000}) => askMemory({theory, repo, session, query, budget, limits: {maxLookups: 300000, maxProbes: 600000, maxFacts: 60000, retrievalMs: 60000, ...limits}});
if (process.env.QF_DBG) { for (const q of JSON.parse(process.env.QF_DBG)) { const a = ask(q); console.error('DBG', a.status, a.reason, JSON.stringify(a.budget), JSON.stringify(a.retrieval).slice(0, 600)); } }
test.after(() => { fs.rmSync(root, {recursive: true, force: true}); });

const countriesIn = continent => [...Array(60).keys()].filter(i => countryContinent(i) === continent);
const byArea = continent => countriesIn(continent).sort((a, b) => countryArea(b) - countryArea(a));
const answers = a => a.rows.map(r => Object.values(r)[0]);

test('superlative: the largest country of a continent over a transitive memory is exact when the slice settles', () => {
  const a = ask('@q query\n  select ?x\n  where all\n    is_a ?x country\n    located_in ?x europe\n    area_of ?x ?v\n  end\n  rank highest ?v\n');
  assert.equal(a.status, 'supported');
  assert.deepEqual(answers(a), ['country' + byArea('europe')[0]]);
  assert.equal(a.retrieval.complete, true);
});

test('ordinal and top-N: the second, the third and the three largest', () => {
  const rank = tail => answers(ask(`@q query\n  select ?x\n  where all\n    is_a ?x country\n    located_in ?x asia\n    area_of ?x ?v\n  end\n  rank highest ?v${tail}\n`));
  const order = byArea('asia').map(i => 'country' + i);
  assert.deepEqual(rank(' position 2'), [order[1]]);
  assert.deepEqual(rank(' position 3'), [order[2]]);
  assert.deepEqual(rank(' top 3').sort(), order.slice(0, 3).sort());
  assert.deepEqual(rank(' position 99'), []);
});

test('superlative over the most populous city of a country (a join through the transitive rule)', () => {
  const a = ask('@q query\n  select ?x\n  where all\n    is_a ?x city\n    located_in ?x europe\n    population_of ?x ?v\n  end\n  rank highest ?v\n');
  const cities = [...Array(3000).keys()].filter(i => countryContinent(cityCountry(i)) === 'europe').sort((x, y) => cityPopulation(y) - cityPopulation(x));
  assert.equal(a.status, 'supported');
  assert.deepEqual(answers(a), ['city' + cities[0]]);
});

test('honesty: a ranking over a slice that cannot be completed is incomplete, never the best of the part', () => {
  const a = ask('@q query\n  select ?x\n  where all\n    is_a ?x city\n    population_of ?x ?v\n  end\n  rank highest ?v\n', {maxFacts: 200, maxLookups: 300});
  assert.equal(a.status, 'incomplete');
  assert.equal(a.complete, false);
  assert.notEqual(a.status, 'supported');
});

test('count: exact over a settled slice, a lower bound when the budget ends first', () => {
  const exact = ask('@q query\n  mode count\n  select ?x\n  where located_in ?x country5\n');
  const expected = [...Array(3000).keys()].filter(i => cityCountry(i) === 5).length;
  assert.equal(exact.status, 'supported');
  assert.equal(exact.count, expected);
  const bounded = ask('@q query\n  mode count\n  select ?x\n  where all\n    is_a ?x city\n    population_of ?x ?v\n  end\n', {maxFacts: 200, maxLookups: 300});
  assert.equal(bounded.status, 'incomplete');
  assert.equal(bounded.bound, 'at_least');
  assert.equal(bounded.count, undefined);
});

test('comparative choice: naming the candidates keeps the retrieval to their facts, not to 3000 cities', () => {
  const a = ask('@q query\n  select ?x\n  where population_of ?x ?v\n  compare any\n    ?x equal city17\n    ?x equal city2000\n  end\n  rank highest ?v\n');
  assert.equal(a.status, 'supported');
  assert.deepEqual(answers(a), [cityPopulation(17) > cityPopulation(2000) ? 'city17' : 'city2000']);
  assert.ok(a.retrieval.facts < 40, `retrieved ${a.retrieval.facts} facts`);
  assert.equal(a.retrieval.complete, true);
});

test('comparative yes/no: two values joined by compare', () => {
  const a = ask('@q query\n  mode exists\n  where all\n    area_of country3 ?a\n    area_of country9 ?b\n  end\n  compare ?a above ?b\n');
  assert.equal(a.status, countryArea(3) > countryArea(9) ? 'supported' : 'refuted');
});

test('derived measure: years lived is computed by the rule from the birth and death years, for one person and for the longest life', () => {
  const one = ask('@q query\n  select ?n\n  where lived_years person123 ?n\n');
  assert.equal(one.status, 'supported');
  assert.deepEqual(answers(one), [died(123) - born(123)]);
  assert.ok(one.retrieval.facts < 20);
  const longest = ask('@q query\n  select ?x\n  where lived_years ?x ?n\n  rank highest ?n\n');
  const best = Math.max(...[...Array(3000).keys()].map(i => died(i) - born(i)));
  assert.equal(longest.status, 'supported');
  assert.deepEqual(answers(longest).map(x => died(Number(x.slice(6))) - born(Number(x.slice(6)))), answers(longest).map(() => best));
});
