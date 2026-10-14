/**
 * Stratified bottom-up closure (naive evaluation, in rounds). Strata run in dependency order; inside a stratum every round
 * applies all rules to the evidence committed by the previous round and commits the new conclusions together, so the number of
 * rounds is exact and a `maxRounds` cut leaves a well-defined partial closure (every derived atom is sound, the closure of the
 * cut stratum is incomplete and the later strata are not computed).
 *
 * Negation as failure (`absent`) and aggregates only read strata below their own, so what they read is final.
 */
import {Evidence} from './evidence.mjs';
import {join} from './join.mjs';
import {BudgetStop} from './budget.mjs';
import {argsKey, groundArgs, ProgramError, compute} from './values.mjs';

const pendingKey = n => `${n.neg ? 'n' : 'p'}|${n.p}|${argsKey(n.args)}`;

function fireRules(rules, ctx, pending) {
  for (const rule of rules) {
    let fanout = 0;
    for (const alt of rule.alts) {
      for (const {env, prem} of join(alt.leaves, 0, {}, [], ctx)) {
        if (++fanout > ctx.budget.limits.maxFanout) ctx.budget.fail('maxFanout');
        const args = groundArgs(rule.head.args, env);
        const node = {neg: rule.head.neg, p: rule.head.p, args, kind: 'rule', ref: rule.source, ruleId: rule.id, premises: prem, binding: env};
        if (ctx.ev.get(node.neg, node.p, args)) continue;
        const k = pendingKey(node);
        if (ctx.blocked?.has(k)) continue;
        if (!pending.has(k)) pending.set(k, node);
      }
    }
  }
}

const orderValue = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** One aggregate: rows are the distinct bindings of all variables of `over`; groups by the `group` variables. */
function fireAggregate(agg, ctx, pending) {
  const rows = new Map();
  for (const alt of agg.alts) {
    for (const {env, prem} of join(alt.leaves, 0, {}, [], ctx)) {
      const rv = {};
      for (const v of agg.rowVars) if (v in env) rv[v] = env[v];
      const k = JSON.stringify(rv);
      if (!rows.has(k)) rows.set(k, {env: rv, prem});
    }
  }
  const groups = new Map();
  for (const row of rows.values()) {
    const gv = agg.group.map(v => row.env[v]);
    const gk = argsKey(gv);
    if (!groups.has(gk)) groups.set(gk, {gv, rows: []});
    groups.get(gk).rows.push(row);
  }
  for (const {gv, rows: members} of groups.values()) {
    const values = agg.field ? members.map(r => r.env[agg.field]) : [];
    let result;
    if (agg.fn === 'count') result = members.length;
    else if (agg.fn === 'collect') result = JSON.stringify([...new Set(values)].sort(orderValue));
    else {
      const nums = values.filter(Number.isFinite);
      if (nums.length !== values.length) ctx.notes.add('aggregate_non_number_ignored');
      if (!nums.length) continue;
      result = agg.fn === 'sum' ? nums.reduce((s, x) => compute('plus', s, x) ?? NaN, 0) : agg.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
      if (!Number.isFinite(result)) continue;
    }
    const env = {...Object.fromEntries(agg.group.map((v, i) => [v, gv[i]])), [agg.out]: result};
    const args = groundArgs(agg.yields.args, env);
    if (!args) throw new ProgramError('unsafe_head', `the yields of ${agg.id} uses a variable that is neither grouped nor the output`, agg.id);
    const premises = [...new Set(members.flatMap(r => r.prem))];
    const node = {neg: false, p: agg.yields.p, args, kind: 'aggregate', ref: agg.source, ruleId: agg.id, premises, binding: env};
    if (ctx.ev.get(false, node.p, args)) continue;
    const k = pendingKey(node);
    if (!pending.has(k)) pending.set(k, node);
  }
}

function runStratum(stratum, ctx) {
  let round = 0;
  for (;;) {
    const pending = new Map();
    fireRules(stratum.rules, ctx, pending);
    for (const agg of stratum.aggregates) fireAggregate(agg, ctx, pending);
    if (!pending.size) return;
    ctx.budget.round(++round);
    for (const node of pending.values()) { ctx.budget.fact(); ctx.ev.add(node); }
  }
}

/**
 * Close the facts of a view under the program. Returns {ev, ctx, exhausted}: `exhausted` is null when the closure is complete,
 * else {reason, key, stratum}. A cut closure holds only sound conclusions. `blocked` lists conclusions that are never derived.
 */
export function saturate(program, facts, budget, {blocked = null} = {}) {
  const ev = new Evidence();
  const stored = new Map();
  for (const f of facts) {
    ev.add({neg: f.neg, p: f.p, args: f.args, kind: 'fact', ref: f.claim, factId: f.id, premises: [], status: f.status, speaker: f.speaker});
    if (!stored.has(f.p)) stored.set(f.p, []);
    stored.get(f.p).push(f);
  }
  // `blocked` ([{neg, p, args}]): conclusions that are never derived (the causal intervention of a counterfactual simulation)
  const ctx = {ev, stored, budget, notes: new Set(), blocked: blocked?.length ? new Set(blocked.map(pendingKey)) : null};
  let exhausted = null;
  let at = 0;
  try {
    for (; at < program.strata.length; at++) runStratum(program.strata[at], ctx);
  } catch (e) {
    if (!(e instanceof BudgetStop)) throw e;
    exhausted = {reason: e.reason, key: e.key, stratum: at};
  }
  return {ev, ctx, exhausted};
}
