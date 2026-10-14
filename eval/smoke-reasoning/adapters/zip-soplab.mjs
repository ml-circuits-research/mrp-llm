/**
 * LEGACY: superseded by `datalog-soplab.mjs` (product strategy with the engine vendored); not registered in index.mjs. Kept as `zip-datalog-soplab` to compare with the unpacked zip when it is present.
 *
 * Adapter wired READ-ONLY to the unpacked soplab engine (sop-reasoning-lab v0.4.0, zip `soplab-v0.4.0.zip`).
 * It needs no install: soplab is dependency-free plain Node. The copy lives in the gitignored
 * datasets_sources/experiments_unpacked/ (override with SOPLAB_DIR); when it is absent the adapter is `unavailable`.
 *
 * Lowering (new circuits -> soplab CNL): fact -> claim (negative fact -> VALUE NOT ...); rule -> rule with WHEN/AND,
 * `not p` -> NOT p, `absent p` -> NONE p, compare -> TEST; default and integrity are desugared first (lib/desugar.mjs);
 * aggregate -> an `all` wire for `over` plus a `reduce` wire plus a materializing rule; action -> transition; goal ->
 * goal; hypothesis -> assumption. The quantifier `every`, `exists`, `count` and `explain` are computed by the adapter
 * over soplab rows and its proof DAG (soplab has no quantifier wire). Not expressible in soplab: validity intervals,
 * compute in rule bodies, constraints, methods, why_not and epistemic status of knowledge facts.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parse, tokens, parseCondition, leaves} from '../validator.mjs';
import {desugarText} from '../lib/desugar.mjs';
import {supposedWireIds} from '../lib/governance.mjs';
import {NotExpressible} from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const labDir = () => process.env.SOPLAB_DIR ?? path.join(repo, 'datasets_sources/experiments_unpacked/soplab-v0.4.0/sop-reasoning-lab');
const OPS = {above: '>', below: '<', at_least: '>=', at_most: '<=', equal: '==', not_equal: '!='};

const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);
const atomText = (neg, p, terms) => `${neg === 'not' ? 'NOT ' : ''}${p} ${terms.join(' ')}`;

function conds(fields, first, rest = 'AND') {
  const out = [];
  let head = true;
  const kw = () => { const k = head ? first : rest; head = false; return k; };
  for (const f of fields) {
    const sink = [];
    const tree = parseCondition(f, sink);
    if (sink.length) throw new NotExpressible('bad condition');
    if (tree.kind === 'any') throw new NotExpressible('any-groups are not lowered by this adapter');
    for (const l of leaves(tree)) {
      if (l.kind === 'atom') out.push(l.neg === 'absent' ? `NONE ${l.p} ${l.terms.join(' ')}` : `${kw()} ${atomText(l.neg, l.p, l.terms)}`);
      else if (l.kind === 'compare') out.push(`TEST ${l.left} ${OPS[l.word]} ${l.right}`);
      else throw new NotExpressible(`${l.kind} in a condition is not available in soplab`);
    }
  }
  // soplab needs a positive start line; NONE/TEST-only bodies are not valid
  if (!out.some(x => /^(WHEN|WHERE|MATCH) /.test(x))) throw new NotExpressible('a body needs a positive atom');
  return out;
}

export function lowerToSoplab({knowledge, query}) {
  const qw = parse(query).wires, kwAll = parse(knowledge).wires;
  const asof = qw.find(w => w.type === 'query')?.fields.find(f => f.key === 'asof')?.value.trim() ?? null;
  const core = desugarText(knowledge, {asof, include: supposedWireIds(qw, kwAll)});
  const kw = parse(core).wires;
  const out = [];
  const supposed = [];
  for (const w of kw) {
    switch (w.type) {
      case 'predicate': break;
      case 'fact': {
        const holds = f1(w, 'holds').value.trim();
        const st = f1(w, 'status')?.value.trim() ?? 'observed';
        if (st !== 'observed') throw new NotExpressible('epistemic status of knowledge facts is not available in soplab');
        const v = f1(w, 'valid')?.value.trim() ?? 'timeless';
        if (v !== 'timeless') throw new NotExpressible('validity intervals are not available in soplab');
        out.push(`@${w.id} claim`, `VALUE ${holds}`);
        break;
      }
      case 'rule': {
        const then = f1(w, 'then').value.trim();
        out.push(`@${w.id} rule`, ...conds(fAll(w, 'when'), 'WHEN'), `THEN ${then}`);
        break;
      }
      case 'aggregate': {
        const over = fAll(w, 'over');
        const vars = new Set();
        for (const f of over) { const tree = parseCondition(f, []); for (const l of leaves(tree)) if (l.kind === 'atom') l.terms.filter(t => t.startsWith('?')).forEach(t => vars.add(t)); }
        const agg = ['count', 'sum', 'min', 'max', 'collect'].map(k => ({k, f: f1(w, k)})).find(x => x.f);
        const t = tokens(agg.f.value), out1 = t.at(-1), field = t.length === 3 ? t[0] : null;
        const group = f1(w, 'group') ? tokens(f1(w, 'group').value) : [];
        const lines = conds(over, 'MATCH', 'MATCH');
        out.push(`@${w.id}_rows all`, `GIVES ${[...vars].join(' ')}`, ...lines);
        out.push(`@${w.id} reduce`, `GIVES ${[...group, out1].join(' ')}`, `FROM $${w.id}_rows ${[...vars].join(' ')}`);
        if (group.length) out.push(`GROUP ${group.join(' ')}`);
        out.push(`${agg.k.toUpperCase()} ${field ? field + ' ' : ''}AS ${out1}`);
        const y = tokens(f1(w, 'yields').value);
        out.push(`@${w.id}_rule rule`, `WHEN $${w.id} ${[...group, out1].join(' ')}`, `THEN ${y.join(' ')}`);
        break;
      }
      case 'action': {
        out.push(`@${w.id} transition`, ...conds(fAll(w, 'requires'), 'WHEN'));
        for (const f of fAll(w, 'removes')) out.push(`REMOVE ${f.value}`);
        for (const f of fAll(w, 'adds')) out.push(`ADD ${f.value}`);
        out.push(`COST ${f1(w, 'cost')?.value ?? 1}`);
        break;
      }
      case 'hypothesis': out.push(`@${w.id} assumption`, `VALUE ${f1(w, 'holds').value}`, `COST ${f1(w, 'cost')?.value ?? 1}`); break;
      default: throw new NotExpressible(`wire type ${w.type} is not available in soplab`);
    }
  }
  const policy = {};
  let q = null;
  for (const w of qw) {
    if (w.type === 'policy') for (const f of w.fields) policy[f.key] = Number(f.value);
    else if (w.type === 'fact') supposed.push(w);
    else if (w.type === 'query') q = w;
    else if (w.type === 'constraint') throw new NotExpressible('numeric constraints are not available in soplab');
  }
  if (!q) throw new NotExpressible('no query');
  return {text: out.join('\n') + '\n', q, supposed, policy};
}

function substitute(atomText, bindings) {
  return atomText.replace(/\?[a-z][a-z0-9_]*/g, v => (bindings[v] !== undefined ? String(bindings[v]) : v));
}

const whereOf = q => {
  const parts = [];
  for (const f of fAll(q, 'where')) {
    const tree = parseCondition(f, []);
    for (const l of leaves(tree)) {
      if (l.kind !== 'atom' || l.neg === 'absent') throw new NotExpressible('query condition not available in soplab');
      parts.push({neg: l.neg, p: l.p, terms: l.terms});
    }
  }
  return parts;
};

function proofDepth(r, atom) {
  const rec = r.store.get(atom);
  const seen = new Set();
  const visit = record => {
    if (!record || seen.has(record.key)) return {depth: 0, uses: []};
    seen.add(record.key);
    const rule = record.proofs.find(p => p.kind === 'rule');
    if (!rule) return {depth: 0, uses: [record.atom]};
    const subs = (rule.premises ?? []).map(k => (typeof k === 'string' ? visit(r.store.claims.get(k)) : {depth: 0, uses: []}));
    return {depth: 1 + Math.max(0, ...subs.map(s => s.depth)), uses: subs.flatMap(s => s.uses)};
  };
  return rec ? visit(rec) : {depth: 0, uses: []};
}
const showAtom = a => [a.sign === -1 ? 'not' : null, a.pred, ...a.args].filter(x => x !== null && x !== undefined).join(' ');

export const zipSoplab = {
  id: 'zip-datalog-soplab', status: 'available', origin: 'soplab-v0.4.0.zip (sop-reasoning-lab), read-only from datasets_sources/experiments_unpacked/',
  description: 'LEGACY (superseded by the product strategy datalog-soplab, not registered in adapters/index.mjs; kept for a side-by-side check against the unpacked zip): soplab: relation-of-bindings engine with naive/delta evaluation, stratified NONE, reduce aggregates, transition planner, min-cost abduction. Plain Node, no install.',
  supports: new Set(['facts', 'select', 'open_world', 'classical_negation', 'rules', 'recursion', 'conflict', 'naf', 'closed_world', 'count', 'every', 'exists', 'conjunction', 'explain', 'aggregate', 'default', 'integrity', 'compare_in_rules', 'plan', 'abduce', 'whatif', 'budget', 'versions', 'overrides', 'strict_contrary', 'closed_derived']),
  async available() { return fs.existsSync(path.join(labDir(), 'src/index.mjs')) ? {ok: true} : {ok: false, reason: 'unpacked soplab not found (unzip experiments/soplab-v0.4.0.zip into datasets_sources/experiments_unpacked/)'}; },
  async run(c, ctx) {
    const lab = await import(pathToFileURL(path.join(labDir(), 'src/index.mjs')).href);
    const low = lowerToSoplab({knowledge: c.knowledge, query: c.query});
    const mode = f1(low.q, 'mode')?.value.trim() ?? 'select';
    const where = whereOf(low.q);
    const supposedText = low.supposed.map(w => `@${w.id} claim\nVALUE ${f1(w, 'holds').value}`).join('\n');
    const wText = where.map((a, i) => `${i === 0 ? 'WHERE' : 'AND'} ${atomText(a.neg, a.p, a.terms)}`).join('\n');
    if (mode === 'why_not') throw new NotExpressible('mode why_not is not available in soplab');
    if (mode === 'plan' || mode === 'abduce') {
      const text = `${low.text}${supposedText ? supposedText + '\n' : ''}@goal goal\n${wText}\n`;
      ctx.lowered = text;
      const parsed = lab.parseSOP(text);
      if (mode === 'plan') {
        const r = lab.planParsed(parsed);
        if (!r.found) return r.exhausted ? {status: 'no_plan', complete: true} : {status: 'budget_exhausted', complete: false};
        return {status: 'plan_found', complete: true, plan: {steps: r.path.length, cost: r.cost, names: r.path.map(x => x.transition)}};
      }
      const r = lab.abductParsed(parsed);
      if (!r.found) return {status: 'unknown', complete: true, hypotheses: []};
      return {status: 'hypotheses', complete: true, hypotheses: [r.assumptions.map(a => showAtom(a.atom))]};
    }
    const text = `${low.text}${supposedText ? supposedText + '\n' : ''}@goal goal\n${wText}\n`;
    ctx.lowered = text;
    const parsed = lab.parseSOP(text);
    const r = lab.loadSOP(new lab.Reasoner(), parsed);
    const maxRounds = low.policy.maxRounds ?? 1000;
    const selectVars = f1(low.q, 'select') ? tokens(f1(low.q, 'select').value) : null;
    const res = r.evaluate(parsed.goals[0].where, {maxRounds, select: selectVars, scope: 'global'});
    const complete = res.materialization?.converged !== false;
    const rows = res.rows.map(x => Object.fromEntries(Object.entries(x.bindings).filter(([k]) => !selectVars || selectVars.includes(k)).map(([k, v]) => [k.replace(/^\?/, ''), v])));
    const conditional = low.supposed.length > 0 || undefined;
    const worker = res.reasoner;
    const askAtom = a => worker.ask(lab.parseAtom(atomText(a.neg, a.p, a.terms).replace(/^NOT /, 'NOT ')));
    const finish = o => ({...o, complete, conditional});
    if (mode === 'select') return finish({status: rows.length ? 'supported' : (complete ? 'unknown' : 'budget_exhausted'), rows});
    if (mode === 'count') return finish({status: 'supported', count: rows.length});
    if (mode === 'exists') {
      if (where.length === 1 && !where[0].terms.some(t => t.startsWith('?'))) {
        const s = askAtom(where[0]).status;
        return finish({status: !complete && s === 'unknown' ? 'budget_exhausted' : s === 'conflicting' ? 'both' : s});
      }
      if (rows.length) return finish({status: 'supported'});
      return finish({status: complete ? 'unknown' : 'budget_exhausted'});
    }
    if (mode === 'explain') {
      const a = where[0];
      const s = askAtom(a);
      if (s.status !== 'supported') return finish({status: s.status});
      const d = proofDepth(worker, lab.parseAtom(atomText(a.neg, a.p, a.terms)));
      return finish({status: 'supported', explain: {depth: d.depth, uses: d.uses.map(showAtom)}});
    }
    if (mode === 'every') {
      const scope = fAll(low.q, 'scope').flatMap(f => leaves(parseCondition(f, [])));
      let refuted = false, unknown = false;
      for (const row of res.rows) for (const sAtom of scope) {
        const t = sAtom.terms.map(x => substitute(x, row.bindings));
        const s = worker.ask(lab.parseAtom(atomText(sAtom.neg, sAtom.p, t)));
        if (s.status === 'refuted' || s.status === 'conflicting') refuted = true; else if (s.status !== 'supported') unknown = true;
      }
      return finish({status: refuted ? 'refuted' : unknown ? 'unknown' : 'supported'});
    }
    throw new NotExpressible('mode ' + mode + ' not lowered');
  }
};
