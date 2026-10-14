/**
 * Generators of the VRC planning worlds as ChatSOP circuits (extension E2, numeric `action`): the energy world, the product world
 * and the guard-rich control, ported from vrc03r `experiments/generate-planning.mjs` and `test/fixture-builders.mjs`.
 * The relational mode machine of VRC (`mode-step`) becomes flags `normal` and `service` with one action per (mode, action) pair.
 * Run `node eval/smoke-reasoning/bench/vrc-worlds.mjs write` to regenerate the circuits of the cases 70 to 72.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MODES = [['normal', 'a0', 'normal'], ['normal', 'a1', 'normal'], ['normal', 'a2', 'service'], ['normal', 'a3', 'normal'],
  ['service', 'a0', 'normal'], ['service', 'a1', 'service'], ['service', 'a2', 'service'], ['service', 'a3', 'normal']];

const header = entity => `@normal predicate
  args none
@service predicate
  args none
@state predicate
  args subject:entity topic:entity object:rational

@m0 fact
  holds normal
`;

function facts(entity, vars, values) {
  return vars.map((v, i) => `@s_${v} fact\n  holds state ${entity} ${v} ${values[i]}\n`).join('\n');
}

function actions(vars, nextFor, guards) {
  const out = [];
  for (let a = 0; a < 4; a++) {
    for (const [from, name, to] of MODES.filter(m => m[1] === `a${a}`)) {
      const lines = [`@a${a}_${from} action`, `  requires ${from}`];
      if (from !== to) lines.push(`  removes ${from}`, `  adds ${to}`);
      for (const g of guards) lines.push(`  guard ${g}`);
      for (const v of vars) lines.push(`  next ${v} ${nextFor(a, v)}`);
      out.push(lines.join('\n') + '\n');
    }
  }
  return out.join('\n');
}

const query = (entity, goal, horizon) => `@q query
  mode plan
  observe ${entity} ?q at_least ${goal}
  horizon ${horizon}
`;

/** Energy world: pairs (x, y) rotated by the four dihedral maps, q accumulates sums of squares per bucket (i mod 4). */
export function energyWorld({groups = 12, entity = 'demo', target = null, horizon = 28, values = null, scales = [1, 1, 1, 1]} = {}) {
  const vals = values ?? Array.from({length: groups}, (_, i) => [i + 1, (i % 5) + 1]);
  const vars = ['q'];
  for (let i = 0; i < groups; i++) vars.push(`x${i}`, `y${i}`);
  const buckets = [[], [], [], []];
  for (let i = 0; i < groups; i++) buckets[i % 4].push(i);
  const energies = buckets.map(b => b.reduce((s, i) => s + vals[i][0] ** 2 + vals[i][1] ** 2, 0));
  const increments = energies.map((e, a) => e * scales[a]);
  const goal = target ?? 19 * Math.max(...increments) + 1;
  const nextFor = (a, v) => {
    if (v === 'q') {
      const sum = buckets[a].length ? buckets[a].map(i => `?x${i}^2 + ?y${i}^2`).join(' + ') : '0';
      return `?q + ${scales[a] === 1 ? sum : `${scales[a]} * (${sum})`}`;
    }
    const i = Number(v.slice(1)), t = (a * 3 + i * 5) % 4, x = `?x${i}`, y = `?y${i}`;
    const [nx, ny] = [[y, `-1 * ${x}`], [`-1 * ${y}`, x], [`-1 * ${x}`, y], [x, `-1 * ${y}`]][t];
    return v[0] === 'x' ? nx : ny;
  };
  const knowledge = header(entity) + '\n' + facts(entity, vars, [0, ...vals.flat()]) + '\n' + actions(vars, nextFor, ['?q below 1000000000']);
  return {knowledge, query: query(entity, goal, horizon), increments, goal, variables: vars.length};
}

/** Product world: pairs (a, b) scaled, swapped or negated; the products a*b are invariant. */
export function productWorld({groups = 10, entity = 'demo', target = null, horizon = 24, values = null, scales = [1, 1, 1, 1]} = {}) {
  const vals = values ?? Array.from({length: groups}, (_, i) => [i + 1, (i % 4) + 1]);
  const vars = ['q'];
  for (let i = 0; i < groups; i++) vars.push(`a${i}`, `b${i}`);
  const buckets = [[], [], [], []];
  for (let i = 0; i < groups; i++) buckets[i % 4].push(i);
  const products = buckets.map(b => b.reduce((s, i) => s + vals[i][0] * vals[i][1], 0));
  const increments = products.map((p, a) => p * scales[a]);
  const goal = target ?? 17 * Math.max(...increments) + 1;
  const nextFor = (a, v) => {
    if (v === 'q') {
      const sum = buckets[a].length ? buckets[a].map(i => `?a${i} * ?b${i}`).join(' + ') : '0';
      return `?q + ${scales[a] === 1 ? sum : `${scales[a]} * (${sum})`}`;
    }
    const i = Number(v.slice(1)), t = (a * 3 + i * 5) % 4, A = `?a${i}`, B = `?b${i}`;
    const [na, nb] = [[`2 * ${A}`, `1/2 * ${B}`], [`1/2 * ${A}`, `2 * ${B}`], [B, A], [`-1 * ${A}`, `-1 * ${B}`]][t];
    return v[0] === 'a' ? na : nb;
  };
  const knowledge = header(entity) + '\n' + facts(entity, vars, [0, ...vals.flat()]) + '\n' + actions(vars, nextFor, ['?q below 1000000000']);
  return {knowledge, query: query(entity, goal, horizon), increments, goal, variables: vars.length};
}

/**
 * The guard-rich control (VRC `guard-and-mode`): one bilinear observable q += a*b with two laws (scale, swap) and a guard `?a at_least 1`
 * that does not factor through any smaller encoding of (a, b): the certified encoding is the identity and compression cannot help.
 */
export function guardRichControl({entity = 'demo', a = 2, b = 3, goal = 12, horizon = 6} = {}) {
  const knowledge = `@ready predicate
  args none
@state predicate
  args subject:entity topic:entity object:rational

@m0 fact
  holds ready
@sq fact
  holds state ${entity} q 0
@sa fact
  holds state ${entity} a ${a}
@sb fact
  holds state ${entity} b ${b}

@scale action
  requires ready
  guard ?a at_least 1
  next q ?q + ?a * ?b
  next a 2 * ?a
  next b 1/2 * ?b

@swap action
  requires ready
  guard ?a at_least 1
  next q ?q + ?a * ?b
  next a ?b
  next b ?a
`;
  return {knowledge, query: query(entity, goal, horizon), goal};
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === 'write') {
  const root = path.resolve(here, process.env.CASES_DIR ?? '../cases-pending');
  const put = (dir, w) => { fs.mkdirSync(path.join(root, dir), {recursive: true}); fs.writeFileSync(path.join(root, dir, 'knowledge.sop'), w.knowledge); fs.writeFileSync(path.join(root, dir, 'query.sop'), w.query); };
  put('70-vrc-energy-world-small', energyWorld({groups: 4, values: [[1, 1], [2, 2], [3, 3], [4, 4]], target: 100, horizon: 8}));
  put('71-vrc-product-world-small', productWorld({groups: 3, values: [[1, 2], [2, 3], [3, 1]], target: 20, horizon: 6}));
  put('72-vrc-guard-rich-control', guardRichControl());
  put('73-vrc-horizon-budget', energyWorld({groups: 4, values: [[1, 1], [2, 2], [3, 3], [4, 4]], target: 100, horizon: 3}));
  console.log('written');
}
