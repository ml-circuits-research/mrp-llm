/**
 * Compare a normalized strategy result with a case's expected.json (round 2: conditional is a list of assumption ids;
 * bound, reason, used, blocked_by, compliance and procedure are checked when the case states them).
 *
 * Normalized result (what every adapter returns):
 *   {status, complete, rows?, count?, conditional?, witness?, objective?, plan?: {cost, steps, names},
 *    hypotheses?: string[][], explain?: {depth, uses}, missing?: string[][], route?: string}
 * Rows are objects keyed by variable name without "?". Comparison is order-insensitive for sets.
 */
const key = v => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)));
const setOf = rows => new Set(rows.map(key));
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const normSets = xs => new Set(xs.map(x => JSON.stringify([...x].sort())));

export function compare(expected, got) {
  const why = [];
  const complete = got.complete ?? true;
  // Status. An incomplete result may only be a budget status, never a negative or unknown answer.
  const acceptableIncomplete = expected.acceptable_if_incomplete ?? [];
  if (complete === false && acceptableIncomplete.includes(got.status)) {
    // fine: honest budget report
  } else if (got.status !== expected.status) why.push(`status ${got.status}, expected ${expected.status}`);
  if (complete === false && ['unknown', 'refuted', 'impossible', 'no_plan', 'optimal'].includes(got.status)) why.push(`incomplete result reported as ${got.status} (budget exhaustion must never read as a negative answer)`);
  if (expected.complete !== undefined && complete !== expected.complete && !(complete === false && acceptableIncomplete.includes(got.status))) why.push(`complete ${complete}, expected ${expected.complete}`);
  if (expected.budget?.must_exhaust && complete !== false) why.push('budget was expected to run out but the result claims to be complete');
  if (expected.rows) {
    if (!got.rows) why.push('no rows returned');
    else if (!sameSet(setOf(got.rows), setOf(expected.rows))) why.push(`rows ${JSON.stringify(got.rows)} differ from ${JSON.stringify(expected.rows)}`);
  }
  if (expected.rows_subset_of) {
    const full = setOf(expected.rows_subset_of), g = setOf(got.rows ?? []);
    if (![...g].every(x => full.has(x))) why.push('returned a row that is not a true answer: ' + JSON.stringify(got.rows));
    if ((got.rows?.length ?? 0) < (expected.min_rows ?? 0)) why.push('fewer than ' + expected.min_rows + ' rows');
  }
  if (expected.count !== undefined && got.count !== expected.count) why.push(`count ${got.count}, expected ${expected.count}`);
  // conditional is the LIST of assumption ids (supposed or reported facts, proposed wires) the answer rests on
  const condList = c => (Array.isArray(c) ? c : c ? ['?'] : []);
  const gotCond = condList(got.conditional), expCond = expected.conditional;
  if (Array.isArray(expCond)) {
    if (!sameSet(new Set(gotCond), new Set(expCond))) why.push(`conditional on ${JSON.stringify(gotCond)}, expected ${JSON.stringify(expCond)}`);
  } else if (expCond === true) {
    if (!gotCond.length) why.push('answer is not marked conditional but the case expects a conditional one');
  } else if (gotCond.length) why.push('answer is marked conditional (' + JSON.stringify(got.conditional) + ') but the case expects an unconditional one');
  if (expected.conditional_unknown !== undefined && Boolean(got.conditional_unknown) !== expected.conditional_unknown) why.push(`conditional_unknown ${Boolean(got.conditional_unknown)}, expected ${expected.conditional_unknown}`);
  else if (expected.conditional_unknown === undefined && got.conditional_unknown) why.push('the assumption list is inexact (conditional_unknown) but the case expects an exact one');
  if (!['budget_exhausted'].includes(got.status) && ['horizon', 'depth', 'domain'].includes(got.reason) && complete === false) why.push(`a bounded engine stopped at its ${got.reason} limit but reports ${got.status}: that is budget_exhausted, not a negative answer`);
  if (expected.nonmonotone !== undefined && Boolean(got.nonmonotone) !== expected.nonmonotone) why.push(`nonmonotone ${Boolean(got.nonmonotone)}, expected ${expected.nonmonotone}`);
  if (expected.bound !== undefined && got.bound !== expected.bound) why.push(`bound ${got.bound}, expected ${expected.bound}`);
  if (expected.bound === undefined && got.bound) why.push(`result is only a ${got.bound} bound but the case expects an exact one`);
  if (expected.reason !== undefined && got.reason !== expected.reason) why.push(`reason ${got.reason}, expected ${expected.reason}`);
  // `used` is ONE SUFFICIENT SUPPORT SET, not the set of claims whose deletion changes the answer (round 3, MUST-FIX 3): with two facts that
  // are each sufficient, deletion gives an empty set. `expected.used` lists governed wires (norms, methods, rules, actions) that must be
  // reported; `used_support` lists the inclusion-minimal supports and the result's `used` must contain at least one of them whole, unless
  // the result says `used_incomplete`. Leaf-set equality is never required; the replay in the oracle (lib/used.mjs) is the real check.
  const ukey = x => x.id + '@' + (x.version ?? 1);
  if (expected.used) {
    if (!got.used) why.push('no used list returned');
    else { const g = new Set(got.used.map(ukey)); for (const e of expected.used) if (!g.has(ukey(e))) why.push(`used lacks ${ukey(e)} (got ${JSON.stringify([...g])})`); }
  }
  if (expected.used_support) {
    const g = new Set((got.used ?? []).map(x => x.id));
    if (got.used_incomplete) { if (expected.used_incomplete === false) why.push('used_incomplete, but the case expects a complete support set'); }
    else if (!got.used) why.push('no used list returned');
    else if (!expected.used_support.some(sup => sup.every(id => g.has(id)))) why.push(`used ${JSON.stringify([...g])} contains no whole sufficient support set ${JSON.stringify(expected.used_support)} and is not flagged used_incomplete`);
    if (expected.used_incomplete === true && !got.used_incomplete) why.push('the case expects used_incomplete');
  }
  if (got.used_replay && got.used_replay.ok === false) why.push('replaying used alone in the oracle does not re-derive the answer: ' + got.used_replay.why);
  if (expected.relaxed) {
    if (!got.relaxed) why.push('no relaxed list returned');
    else if (!sameSet(new Set(got.relaxed), new Set(expected.relaxed))) why.push(`relaxed ${JSON.stringify(got.relaxed)}, expected ${JSON.stringify(expected.relaxed)}`);
  }
  if (expected.obligations_triggered) {
    if (!got.obligations_triggered) why.push('no obligations_triggered list returned');
    else if (!sameSet(new Set(got.obligations_triggered), new Set(expected.obligations_triggered))) why.push(`obligations_triggered ${JSON.stringify(got.obligations_triggered)}, expected ${JSON.stringify(expected.obligations_triggered)}`);
  }
  if (expected.row_conditional) {
    const gr = new Map((got.row_conditional ?? []).map(r => [key(r.row ?? {}), r]));
    for (const e of expected.row_conditional) {
      const r = gr.get(key(e.row));
      if (!r) { why.push('no per-row conditional for ' + JSON.stringify(e.row)); continue; }
      if (!sameSet(new Set(r.conditional ?? []), new Set(e.conditional))) why.push(`row ${JSON.stringify(e.row)} conditional on ${JSON.stringify(r.conditional)}, expected ${JSON.stringify(e.conditional)}`);
      if (Boolean(r.conditional_unknown) !== Boolean(e.conditional_unknown)) why.push(`row ${JSON.stringify(e.row)} conditional_unknown ${Boolean(r.conditional_unknown)}, expected ${Boolean(e.conditional_unknown)}`);
    }
  }
  if (expected.blocked_by) {
    if (!got.blocked_by) why.push('no blocked_by returned');
    else if (!sameSet(new Set(got.blocked_by), new Set(expected.blocked_by))) why.push(`blocked_by ${JSON.stringify(got.blocked_by)}, expected ${JSON.stringify(expected.blocked_by)}`);
  }
  // modes of work, round 4 (planner): the step and requirement that block, the wires that bind while contested, the obligations that are
  // standing, the choices the engine made and notes that must appear (each is checked only when the case states it)
  if (expected.blocked) {
    if (!got.blocked) why.push('no blocked info returned');
    else for (const [k, v] of Object.entries(expected.blocked)) if (got.blocked[k] !== v) why.push(`blocked.${k} ${JSON.stringify(got.blocked[k])}, expected ${JSON.stringify(v)}`);
  }
  if (expected.contested) {
    if (!got.contested) why.push('no contested list returned');
    else if (!sameSet(new Set(got.contested), new Set(expected.contested))) why.push(`contested ${JSON.stringify(got.contested)}, expected ${JSON.stringify(expected.contested)}`);
  }
  if (expected.obligation_unscoped) {
    if (!got.obligation_unscoped) why.push('no obligation_unscoped list returned');
    else if (!sameSet(new Set(got.obligation_unscoped), new Set(expected.obligation_unscoped))) why.push(`obligation_unscoped ${JSON.stringify(got.obligation_unscoped)}, expected ${JSON.stringify(expected.obligation_unscoped)}`);
  }
  if (expected.scope_unknown !== undefined && Boolean(got.scope_unknown) !== expected.scope_unknown) why.push(`scope_unknown ${Boolean(got.scope_unknown)}, expected ${expected.scope_unknown}`);
  if (expected.choices) for (const c of expected.choices) if (!(got.choices ?? []).some(g => g.chosen === c.chosen)) why.push(`no choice made of ${c.chosen} (got ${JSON.stringify((got.choices ?? []).map(g => g.chosen))})`);
  if (expected.notes_include) for (const note of expected.notes_include) if (!(got.notes ?? []).some(x => x.startsWith(note))) why.push(`notes lack ${note} (got ${JSON.stringify(got.notes ?? [])})`);
  if (expected.compliance) {
    const e = expected.compliance, g = got.compliance;
    if (!g) why.push('no compliance returned');
    else {
      if (e.hard !== undefined && g.hard !== e.hard) why.push(`compliance.hard ${g.hard}, expected ${e.hard}`);
      if (e.violated && !sameSet(new Set(g.violated ?? []), new Set(e.violated))) why.push(`compliance.violated ${JSON.stringify(g.violated)}, expected ${JSON.stringify(e.violated)}`);
      if (e.soft_violations && JSON.stringify([...(g.soft_violations ?? [])].sort((a, b) => a.id < b.id ? -1 : 1)) !== JSON.stringify([...e.soft_violations].sort((a, b) => a.id < b.id ? -1 : 1))) why.push(`soft_violations ${JSON.stringify(g.soft_violations)}, expected ${JSON.stringify(e.soft_violations)}`);
      if (e.deviations && !sameSet(new Set(g.deviations ?? []), new Set(e.deviations))) why.push(`compliance.deviations ${JSON.stringify(g.deviations)}, expected ${JSON.stringify(e.deviations)}`);
      if (e.total_cost !== undefined && g.total_cost !== e.total_cost) why.push(`total_cost ${g.total_cost}, expected ${e.total_cost}`);
    }
  }
  if (expected.procedure) {
    const e = expected.procedure, g = got.procedure;
    if (!g) why.push('no procedure returned');
    else {
      if (e.id !== undefined && g.id !== e.id) why.push(`procedure ${g.id}, expected ${e.id}`);
      if (e.version !== undefined && g.version !== e.version) why.push(`procedure version ${g.version}, expected ${e.version}`);
      if (e.steps && JSON.stringify(g.steps) !== JSON.stringify(e.steps)) why.push(`procedure steps ${JSON.stringify(g.steps)}, expected ${JSON.stringify(e.steps)}`);
    }
  }
  if (expected.witness) for (const [k, v] of Object.entries(expected.witness)) if (got.witness?.[k] !== v) why.push(`witness ${k}=${got.witness?.[k]}, expected ${v}`);
  if (expected.objective !== undefined && got.objective !== expected.objective) why.push(`objective ${got.objective}, expected ${expected.objective}`);
  if (expected.plan) {
    if (!got.plan) why.push('no plan returned');
    else {
      if (expected.plan.cost !== undefined && got.plan.cost !== expected.plan.cost) why.push(`plan cost ${got.plan.cost}, expected ${expected.plan.cost}`);
      if (expected.plan.steps !== undefined && got.plan.steps !== expected.plan.steps) why.push(`plan steps ${got.plan.steps}, expected ${expected.plan.steps}`);
      if (expected.plan.names && JSON.stringify(got.plan.names) !== JSON.stringify(expected.plan.names)) why.push(`plan step names ${JSON.stringify(got.plan.names)}, expected ${JSON.stringify(expected.plan.names)}`);
    }
  }
  if (expected.hypotheses) {
    if (!got.hypotheses) why.push('no hypotheses returned');
    else if (!sameSet(normSets(got.hypotheses), normSets(expected.hypotheses))) why.push(`hypotheses ${JSON.stringify(got.hypotheses)}, expected ${JSON.stringify(expected.hypotheses)}`);
  }
  if (expected.explain) {
    if (!got.explain) why.push('no explanation returned');
    else {
      if (expected.explain.depth !== undefined && got.explain.depth !== expected.explain.depth) why.push(`explanation depth ${got.explain.depth}, expected ${expected.explain.depth}`);
      for (const u of expected.explain.uses ?? []) if (!got.explain.uses?.includes(u)) why.push('explanation does not use ' + u);
    }
  }
  if (expected.missing) {
    if (!got.missing) why.push('no missing premises returned');
    else if (!sameSet(normSets(got.missing), normSets(expected.missing))) why.push(`missing ${JSON.stringify(got.missing)}, expected ${JSON.stringify(expected.missing)}`);
  }
  if (expected.blockers) {
    // why_not blockers (case 58): the atoms that kill a route (absent_fails) or contradict a repair (contradicts), as a set of atom texts
    if (!got.blockers) why.push('no blockers returned');
    else if (!sameSet(new Set(got.blockers.map(b => (typeof b === 'string' ? b : b.atom))), new Set(expected.blockers))) why.push(`blockers ${JSON.stringify(got.blockers.map(b => (typeof b === 'string' ? b : b.atom)))}, expected ${JSON.stringify(expected.blockers)}`);
  }
  return {ok: why.length === 0, why};
}
