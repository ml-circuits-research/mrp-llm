/**
 * The wires of the modes of work, read into plain objects: `norm`, `method` (with its step tree), `trace` and `hypothesis`
 * with a `waive` (proposal 8.2). Shared by the conform lowering (`../conform/`) and the planner (`../htn-strips-planner/`), so
 * both read a norm, a method or a trace the same way. The parser, the governance filter and the condition compiler come from the
 * knowledge grammar (`sop/knowledge/`) and the oracle's program compiler; nothing here parses wire text itself.
 *
 * Defaults (proposal 8.2): an absent `binding` is `strict` (fail-safe: an omitted field never loosens a prohibition), an absent
 * `severity` is `hard`, a forbid without a qualifier is `always`, an oblige without one is `sometime`.
 */
import {tokens, atomFrom} from '../../../sop/knowledge/lexical.mjs';
import {conditionAlts} from '../js-reference/program.mjs';
import {ProgramError, NotExpressibleError, toTerm, termValue, isVarTerm} from '../js-reference/values.mjs';

export const f1 = (w, k) => w.fields.find(f => f.key === k);
export const fAll = (w, k) => w.fields.filter(f => f.key === k);
const one = (w, k) => f1(w, k)?.value.trim() ?? null;

/** The binding of a governed wire: an absent field is `strict`; a host policy may only tighten it. */
export function bindingOf(w, policyBinding = null) {
  const own = one(w, 'binding') ?? 'strict';
  return policyBinding === 'strict' ? 'strict' : own;
}

export const versionOf = w => Number(one(w, 'version') ?? 1);

// ------------------------------------------------------------------------------------------------------------ norms

const QUALIFIERS = ['always', 'sometime', 'at_most_once', 'within', 'before', 'after'];
const ALLOWED = {forbid: ['always', 'before', 'after', 'at_most_once'], oblige: ['sometime', 'always', 'within', 'before', 'after']};

/** Variables of a list of term objects, in order of first occurrence. */
export const varsOfTerms = terms => [...new Set(terms.filter(isVarTerm).map(t => t.var))];

function readPattern(toks) {
  if (toks[0]?.startsWith('~')) return {kind: 'action', action: toks[0].slice(1), terms: toks.slice(1).map(toTerm), text: toks.join(' ')};
  const a = atomFrom(toks);
  if (a.error) throw new ProgramError('bad_norm_pattern', a.error);
  return {kind: 'state', p: a.p, terms: a.terms.map(toTerm), text: toks.join(' ')};
}

/** One norm wire into {id, version, modality, pat, qual, standing, severity, cost, priority, overrides, binding, whenAlts, ...}. */
export function parseNorm(w, {policyBinding = null} = {}) {
  const modal = ['forbid', 'oblige', 'permit'].filter(k => f1(w, k));
  if (modal.length !== 1) throw new ProgramError('norm_modality', 'a norm has exactly one of forbid, oblige, permit', w.id);
  const modality = modal[0];
  const pat = readPattern(tokens(one(w, modality)));
  const given = QUALIFIERS.filter(k => f1(w, k));
  if (given.length > 1) throw new ProgramError('norm_qualifier', 'a norm has at most one temporal qualifier', w.id);
  let qual = null;
  if (modality !== 'permit') {
    const kind = given[0] ?? (modality === 'forbid' ? 'always' : 'sometime');
    if (!ALLOWED[modality].includes(kind)) throw new ProgramError('norm_qualifier', `${kind} is not a qualifier of ${modality}`, w.id);
    qual = {kind};
    if (kind === 'within') qual.n = Number(one(w, 'within'));
    if (kind === 'before' || kind === 'after') qual.ref = one(w, kind).replace(/^~/, '');
    if (kind === 'always' && modality === 'oblige' && pat.kind !== 'state') throw new ProgramError('norm_qualifier', 'oblige always maintains a state atom', w.id);
  }
  const severity = one(w, 'severity') ?? 'hard';
  const norm = {
    id: w.id, version: versionOf(w), wire: w, modality, pat, qual, standing: Boolean(f1(w, 'standing')), severity,
    cost: Number(one(w, 'cost') ?? 1), priority: Number(one(w, 'priority') ?? 0),
    overrides: fAll(w, 'overrides').map(f => f.value.trim().replace(/^\$/, '')),
    binding: bindingOf(w, policyBinding), message: one(w, 'message')?.replace(/^"|"$/g, '') ?? null,
    scope: one(w, 'scope'), whenAlts: conditionAlts(fAll(w, 'when'), w.id)
  };
  norm.patVars = varsOfTerms(pat.terms);
  return norm;
}

/** Norms that override others: the explicit `overrides` and a higher `priority` over an opposite norm of the same action. */
export function overrideEdges(norms) {
  const byId = new Map(norms.map(n => [n.id, n]));
  const edges = [];
  for (const n of norms) for (const t of n.overrides) if (byId.has(t)) edges.push({over: n.id, target: t});
  const opposite = (a, b) => a.modality !== b.modality && a.pat.kind === 'action' && b.pat.kind === 'action' && a.pat.action === b.pat.action && a.pat.terms.length === b.pat.terms.length;
  for (const a of norms) for (const b of norms) {
    if (a !== b && opposite(a, b) && a.priority > b.priority && !edges.some(e => e.over === a.id && e.target === b.id)) edges.push({over: a.id, target: b.id});
  }
  for (const e of edges) {
    const t = byId.get(e.target);
    if (t.modality !== 'forbid' || t.pat.kind !== 'action') throw new NotExpressibleError(['overrides'], `norm ${e.over} overrides ${e.target}: only a forbid of an action can be overridden`);
  }
  return edges;
}

// --------------------------------------------------------------------------------------------------------- methods

const BLOCK_HEADS = ['choose', 'any_order', 'if', 'until'];

function leafStep(toks) {
  let t = toks, optional = false;
  if (t[0] === 'optional') { optional = true; t = t.slice(1); }
  let node;
  if (t[0] === 'achieve') {
    const a = atomFrom(t.slice(1), {allowNeg: true, allowAbsent: true});
    node = {kind: 'achieve', neg: a.neg, p: a.p, terms: a.terms.map(toTerm)};
  } else if (t[0] === 'pick') {
    const a = atomFrom(t.slice(3), {allowNeg: true, allowAbsent: true});
    node = {kind: 'pick', variable: t[1], neg: a.neg, p: a.p, terms: a.terms.map(toTerm)};
  } else if (t[0]?.startsWith('~')) {
    node = {kind: 'prim', action: t[0].slice(1), terms: t.slice(1).map(toTerm)};
  } else {
    const a = atomFrom(t);
    node = {kind: 'task', p: a.p, terms: a.terms.map(toTerm)};
  }
  node.text = toks.join(' ');
  return optional ? {kind: 'optional', item: node, text: toks.join(' ')} : node;
}

/** Parse the lines of a `step` field (its value and its block) into step nodes; `lines` are trimmed strings. */
function parseStepLines(lines, at = {i: 0}) {
  const out = [];
  while (at.i < lines.length) {
    const text = lines[at.i];
    if (text === 'end' || text === 'else') return out;
    at.i++;
    const toks = tokens(text);
    if (!BLOCK_HEADS.includes(toks[0])) { out.push(leafStep(toks)); continue; }
    if (toks[0] === 'choose' || toks[0] === 'any_order') {
      const items = parseStepLines(lines, at);
      at.i++; // end
      out.push(toks[0] === 'choose' ? {kind: 'choose', branches: items, text} : {kind: 'any_order', items, text});
    } else if (toks[0] === 'if') {
      const a = atomFrom(toks.slice(1), {allowNeg: true, allowAbsent: true});
      const then = parseStepLines(lines, at);
      let otherwise = [];
      if (lines[at.i] === 'else') { at.i++; otherwise = parseStepLines(lines, at); }
      at.i++; // end
      out.push({kind: 'if', neg: a.neg, p: a.p, terms: a.terms.map(toTerm), then, otherwise, text});
    } else {
      const mi = toks.indexOf('max');
      const a = atomFrom(toks.slice(1, mi), {allowNeg: true, allowAbsent: true});
      const body = parseStepLines(lines, at);
      at.i++; // end
      out.push({kind: 'until', neg: a.neg, p: a.p, terms: a.terms.map(toTerm), max: Number(toks[mi + 1]), body, text});
    }
  }
  return out;
}

/** Every line of the `step` fields as written, trimmed (the rendering of a procedure, 35b: a block is kept step by step). */
export const stepLines = w => fAll(w, 'step').flatMap(f => [f.value.trim(), ...f.block.map(b => b.text)]);

let nodeSeq = 0;
function numberNodes(nodes) {
  for (const n of nodes) {
    n.nid = ++nodeSeq;
    if (n.item) numberNodes([n.item]);
    for (const k of ['branches', 'items', 'then', 'otherwise', 'body']) if (n[k]) numberNodes(n[k]);
  }
  return nodes;
}

/** One method wire into {id, version, achieves, whenAlts, steps, prefer, onFailure, binding, cost, triggeredBy, ...}. */
export function parseMethod(w, {policyBinding = null} = {}) {
  const ach = atomFrom(tokens(one(w, 'achieves')));
  const steps = fAll(w, 'step').flatMap(f => parseStepLines([f.value.trim(), ...f.block.map(b => b.text)]));
  const prefer = fAll(w, 'prefer').map(f => { const t = tokens(f.value); return {better: t[0].slice(1), worse: t[t.indexOf('over') + 1].slice(1)}; });
  const of = one(w, 'on_failure');
  return {
    id: w.id, version: versionOf(w), wire: w, achieves: {p: ach.p, terms: ach.terms.map(toTerm)}, whenAlts: conditionAlts(fAll(w, 'when'), w.id),
    steps: numberNodes(steps), prefer, onFailure: of === null ? null : of.startsWith('$') ? {method: of.slice(1)} : of,
    binding: bindingOf(w, policyBinding), cost: Number(one(w, 'cost') ?? 0), triggeredBy: one(w, 'triggered_by'), scope: one(w, 'scope')
  };
}

/** Primitive step nodes (with their action names) of a method, nested ones included. */
export function primitivesOf(nodes, out = []) {
  for (const n of nodes) {
    if (n.kind === 'prim') out.push(n);
    if (n.item) primitivesOf([n.item], out);
    for (const k of ['branches', 'items', 'then', 'otherwise', 'body']) if (n[k]) primitivesOf(n[k], out);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ trace

/** A `trace` wire: ground steps, each optionally ending `at DATE`. Returns [{action, args, at}] with `at` as the written date or null. */
export function parseTrace(w) {
  return fAll(w, 'step').map(f => {
    let t = tokens(f.value);
    let at = null;
    if (t.length > 2 && t.at(-2) === 'at') { at = t.at(-1); t = t.slice(0, -2); }
    return {action: t[0].slice(1), args: t.slice(1).map(termValue), at};
  });
}

/** `waive $norm` hypotheses (and ordinary `holds`/`assume` ones) of the program, for the abduction. */
export function parseHypotheses(wires) {
  return wires.filter(w => w.type === 'hypothesis').map(w => {
    const waive = fAll(w, 'waive').flatMap(f => tokens(f.value).map(t => t.replace(/^\$/, '')));
    return {id: w.id, waive, cost: Number(one(w, 'cost') ?? 1), atoms: [...fAll(w, 'holds'), ...fAll(w, 'assume')].map(f => { const a = atomFrom(tokens(f.value.trim()), {allowNeg: true}); return {neg: a.neg === 'not', p: a.p, args: a.terms.map(termValue)}; })};
  });
}

/** `${id} v1 v2` the way the packet names an obligation instance (`obligations_triggered`) and a violation. */
export const instanceName = (id, values) => [id, ...values.map(v => (typeof v === 'string' && /[^A-Za-z0-9_.:\-]/.test(v) ? JSON.stringify(v) : String(v)))].join(' ');
