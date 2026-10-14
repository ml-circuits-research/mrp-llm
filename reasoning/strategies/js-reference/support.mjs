/**
 * Proofs and `used`. From the first derivation of each node the strategy builds
 *   - `proof`: the minimal DAG of the schema of 5.3, nodes {id, atom, kind: fact|assumption|rule|default|aggregate, source: {id, version},
 *     premises: [node ids], binding, absent?: [atoms whose absence a closed predicate licensed]};
 *   - `used`: ONE sufficient support set, the leaves of one proof (facts, assumptions) plus the rules, defaults and aggregates
 *     applied; `used_incomplete` is set when the proof rests on negation as failure, because the absence it needs cannot be
 *     named as a claim (under-reporting `used` only loses proof-use promotions);
 *   - `explain`: {depth, uses}, the longest chain of rule applications and the stored facts of the proof as text.
 */
import {atomText} from './values.mjs';

const isMarker = p => p && p.absent !== undefined;

/** Walk the derivation graph below the given nodes (each node once). */
function reachable(roots) {
  const seen = new Map();
  const visit = n => {
    if (seen.has(n)) return;
    seen.set(n, null);
    for (const p of n.premises ?? []) if (!isMarker(p)) visit(p);
  };
  roots.forEach(visit);
  return [...seen.keys()];
}

function depthOf(node, memo) {
  if (memo.has(node)) return memo.get(node);
  const subs = (node.premises ?? []).filter(p => !isMarker(p));
  const d = node.kind === 'fact' ? 0 : 1 + Math.max(0, ...subs.map(p => depthOf(p, memo)));
  memo.set(node, d);
  return d;
}

const kindOf = n => (n.kind === 'fact' ? (n.status && n.status !== 'observed' ? 'assumption' : 'fact') : n.kind === 'aggregate' ? 'aggregate' : n.ruleId?.startsWith('x_') ? 'default' : 'rule');

export function proofOf(roots) {
  const nodes = reachable(roots);
  const ids = new Map(nodes.map((n, i) => [n, 'n' + (i + 1)]));
  const dag = nodes.map(n => ({
    id: ids.get(n), atom: atomText(n.neg, n.p, n.args), kind: kindOf(n), source: n.ref,
    premises: (n.premises ?? []).filter(p => !isMarker(p)).map(p => ids.get(p)),
    ...(n.binding && Object.keys(n.binding).length ? {binding: n.binding} : {}),
    ...((n.premises ?? []).some(isMarker) ? {absent: n.premises.filter(isMarker).map(p => atomText(false, p.absent.p, p.absent.args))} : {})
  }));
  return {nodes: dag, roots: roots.map(r => ids.get(r))};
}

export function usedOf(roots) {
  const nodes = reachable(roots);
  const seen = new Map();
  let incomplete = false;
  for (const n of nodes) {
    if (n.ref) seen.set(`${n.ref.id}@${n.ref.version}`, {id: n.ref.id, version: n.ref.version});
    if ((n.premises ?? []).some(isMarker)) incomplete = true;
  }
  return {used: [...seen.values()], used_incomplete: incomplete};
}

export function explainOf(roots) {
  const memo = new Map();
  const nodes = reachable(roots);
  return {
    depth: Math.max(0, ...roots.map(r => depthOf(r, memo))),
    uses: [...new Set(nodes.filter(n => n.kind === 'fact').map(n => atomText(n.neg, n.p, n.args)))]
  };
}
