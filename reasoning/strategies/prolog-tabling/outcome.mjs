/**
 * From the JSON of a Prolog run to the outcome of one view, in the shape the oracle's `combineParts` and packet builders use:
 *   {status, rows: [{row, both, prem}], count?, bound?, reason?, roots, supportIncomplete}
 * The decisions are the proposal's definitions (4.2 item 2, 4.2 item 5): a row is `both` when every derivation of it also has the
 * contrary evidence; a query with no row is `refuted` only when evidence or a CLOSED predicate says no instance can exist, else
 * `unknown`; a count over a predicate that is not closed is a lower bound; an `every` over an open domain without a counterexample
 * is `unknown` (open_domain), a counterexample still refutes.
 */
import {isVarTerm} from '../js-reference/values.mjs';

const stripVar = v => v.replace(/^\?/, '');
export const rowKey = row => JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)));
const litKey = (neg, p, args) => `${neg}|${p}|${JSON.stringify(args)}`;

/** Node objects of the oracle's support.mjs (proofOf, usedOf, explainOf) from the proof nodes of a run. */
export function buildNodes(jsonNodes = []) {
  const byKey = new Map();
  for (const n of jsonNodes) {
    byKey.set(litKey(n.lit.neg, n.lit.p, n.lit.args), {
      neg: n.lit.neg, p: n.lit.p, args: n.lit.args, kind: n.kind, ref: n.ref, ruleId: n.rule_id,
      premises: [], binding: n.binding ?? {}, status: n.status, speaker: n.speaker
    });
  }
  jsonNodes.forEach(n => {
    const node = byKey.get(litKey(n.lit.neg, n.lit.p, n.lit.args));
    node.premises = n.premises.map(p => (p.absent ? {absent: p.absent} : byKey.get(litKey(p.neg, p.p, p.args)))).filter(Boolean);
  });
  return byKey;
}

const premNodes = (lits, nodes) => lits.map(p => (p.absent ? {absent: p.absent} : nodes.get(litKey(p.neg, p.p, p.args)))).filter(Boolean);
const rootNodes = (lits, nodes) => lits.map(l => nodes.get(litKey(l.neg, l.p, l.args))).filter(Boolean);

function rowOf(qp, valuesList) {
  return Object.fromEntries(qp.projection.map((v, i) => [stripVar(v), valuesList[i]]));
}

/** Outcome of select / exists / explain / count over one view. */
export function relationalOutcome(qp, data, nodes) {
  const out = relationalOutcome0(qp, data, nodes);
  // the proofs were dropped (too many nodes): nothing to report as `used`, and no explanation
  return data.truncated ? {...out, truncated: true, supportIncomplete: true, roots: []} : out;
}

function relationalOutcome0(qp, data, nodes) {
  const rows = new Map();
  // well-founded negation: a row whose derivation is UNDEFINED (it depends on a negative loop; the stratified programs the validator
  // admits never produce one) is neither a row nor a refutation
  const undefinedRows = data.rows.filter(r => r.undefined);
  for (const r of data.rows) {
    if (r.undefined) continue;
    const row = rowOf(qp, r.row);
    const k = rowKey(row);
    const old = rows.get(k);
    if (!old) rows.set(k, {row, both: r.both, prem: premNodes(r.prem, nodes)});
    else if (old.both && !r.both) rows.set(k, {row, both: false, prem: premNodes(r.prem, nodes)});
    else if (old.both === r.both && !old.prem.length && r.prem.length) old.prem = premNodes(r.prem, nodes);
  }
  const list = [...rows.values()].sort((a, b) => (rowKey(a.row) < rowKey(b.row) ? -1 : 1));
  const refutedLeaves = new Set(data.refuted.map(([i]) => i));
  const refuted = !list.length && qp.alts.length > 0 && qp.alts.every((_, i) => refutedLeaves.has(i));
  const {mode} = qp;
  if (mode === 'count') {
    const exact = qp.domainClosed;
    const status = list.length || exact ? 'supported' : 'unknown';
    return {status, rows: list, count: list.length, ...(exact ? {} : {bound: 'at_least'}), roots: list.flatMap(r => r.prem), supportIncomplete: true};
  }
  if (list.length) {
    const status = list.some(r => !r.both) ? 'supported' : 'both';
    const first = list.find(r => !r.both) ?? list[0];
    const all = mode === 'select' ? list.flatMap(r => r.prem) : first.prem;
    return {status, rows: list, roots: all, supportIncomplete: false};
  }
  if (undefinedRows.length) return {status: 'unknown', reason: 'well_founded_undefined', rows: [], roots: [], supportIncomplete: true};
  const roots = refuted ? rootNodes(data.roots.map(r => r.lit), nodes) : [];
  return {status: refuted ? 'refuted' : 'unknown', rows: [], roots, supportIncomplete: refuted && !roots.length};
}

/** Outcome of `every`: the members of the domain against the scope. */
export function everyOutcome(qp, data, nodes) {
  const out = everyOutcome0(qp, data, nodes);
  return data.truncated ? {...out, truncated: true, supportIncomplete: true, roots: []} : out;
}

function everyOutcome0(qp, data, nodes) {
  let conflicts = 0, counter = null, unknown = 0;
  const roots = [];
  for (const m of data.members) {
    if (m.r === 'holds') {
      roots.push(...premNodes(m.prem, nodes));
      if (m.both) conflicts++;
    } else if (m.r === 'refuted') {
      counter = counter ?? m.env;
      roots.push(...rootNodes(m.roots, nodes));
    } else unknown++;
  }
  if (counter) return {status: 'refuted', rows: [], roots, supportIncomplete: false, counterexample: counter};
  if (!qp.domainClosed) return {status: 'unknown', reason: 'open_domain', rows: [], roots: [], supportIncomplete: true};
  if (unknown) return {status: 'unknown', reason: 'scope_unknown', rows: [], roots: [], supportIncomplete: true};
  return {status: conflicts ? 'both' : 'supported', rows: [], roots, supportIncomplete: true};
}

export {isVarTerm};
