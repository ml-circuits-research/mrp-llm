/**
 * LEGACY: superseded by `datalog-e10.mjs` (product strategy with the engine vendored); not registered in index.mjs. Kept as `zip-datalog-e10` to compare with the unpacked zip when it is present.
 *
 * Adapter wired READ-ONLY to the unpacked E10 engine (sop_reasoner_e10.zip, package sop-verified-reasoner 0.3.0):
 * bottom-up set-valued function-free Datalog with stratified negation (NONE), explicit negation (FACT NOT / MATCH NOT),
 * SCC scheduling, semi-naive evaluation, greedy joins and magic-set demand rewriting. Plain Node, no install; the copy
 * lives in the gitignored datasets_sources/experiments_unpacked/ (override with E10_DIR).
 *
 * Lowering: fact -> FACT / FACT NOT; rule -> rule (WHEN/AND, NOT p -> AND NOT p, absent p -> NONE p, compare -> TEST);
 * default and integrity are desugared first; query -> query wire with GIVES. Counting, `exists` (a positive and a
 * negative probe) and the quantifier `every` are computed by the adapter over E10 rows. E10 has no aggregate, no
 * compute, no arithmetic terms, no time and no planner: those cases are "not expressible". Budget: E10's own maxWork
 * counter (candidate visits) is fed from the policy key maxJoins; an overrun is INCOMPLETE and exposes no partial rows.
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
const dir = () => process.env.E10_DIR ?? path.join(repo, 'datasets_sources/experiments_unpacked/sop_reasoner_e10/sop_reasoner_e10');
const OPS = {above: '>', below: '<', at_least: '>=', at_most: '<=', equal: '==', not_equal: '!='};
const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);
const up = s => s.trim().replace(/^not /, 'NOT ');

function condLines(fields) {
  const out = [];
  let first = true;
  for (const f of fields) {
    const tree = parseCondition(f, []);
    if (tree.kind === 'any') throw new NotExpressible('any-groups are not lowered by this adapter');
    for (const l of leaves(tree)) {
      if (l.kind === 'atom' && l.neg === 'absent') out.push(`NONE ${l.p} ${l.terms.join(' ')}`);
      else if (l.kind === 'atom') { out.push(`${first ? 'WHEN' : 'AND'} ${l.neg === 'not' ? 'NOT ' : ''}${l.p} ${l.terms.join(' ')}`); first = false; }
      else if (l.kind === 'compare') out.push(`TEST ${l.left} ${OPS[l.word]} ${l.right}`);
      else throw new NotExpressible(`${l.kind} in a condition is not available in E10`);
    }
  }
  if (first) throw new NotExpressible('a rule body needs a positive atom');
  return out;
}

export function lowerToE10({knowledge, query}) {
  const qw = parse(query).wires, kwAll = parse(knowledge).wires;
  const asof = qw.find(w => w.type === 'query')?.fields.find(f => f.key === 'asof')?.value.trim() ?? null;
  const wires = parse(desugarText(knowledge, {asof, include: supposedWireIds(qw, kwAll)})).wires;
  const facts = [], rules = [];
  for (const w of wires) {
    switch (w.type) {
      case 'predicate': break;
      case 'fact': {
        const st = f1(w, 'status')?.value.trim() ?? 'observed';
        if (st !== 'observed') throw new NotExpressible('epistemic status of knowledge facts is not available in E10');
        if ((f1(w, 'valid')?.value.trim() ?? 'timeless') !== 'timeless') throw new NotExpressible('validity intervals are not available in E10');
        facts.push('FACT ' + up(f1(w, 'holds').value));
        break;
      }
      case 'rule': rules.push(`@${w.id} rule`, ...condLines(fAll(w, 'when')), `THEN ${up(f1(w, 'then').value)}`, ''); break;
      default: throw new NotExpressible(`wire type ${w.type} is not available in E10`);
    }
  }
  const policy = {}, supposed = [];
  let qq = null;
  for (const w of qw) {
    if (w.type === 'policy') for (const f of w.fields) policy[f.key] = Number(f.value);
    else if (w.type === 'fact') supposed.push('FACT ' + up(f1(w, 'holds').value));
    else if (w.type === 'query') qq = w;
    else if (w.type === 'constraint') throw new NotExpressible('numeric constraints are not available in E10');
  }
  if (!qq) throw new NotExpressible('no query');
  return {kb: '@facts facts\n' + [...facts, ...supposed].join('\n') + '\n\n' + rules.join('\n'), q: qq, policy, supposed: supposed.length > 0};
}

const varsOf = ts => ts.filter(t => t.startsWith('?'));

export const zipE10 = {
  id: 'zip-datalog-e10', status: 'available', origin: 'sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0), read-only from datasets_sources/experiments_unpacked/',
  description: 'LEGACY (superseded by the product strategy datalog-e10, not registered in adapters/index.mjs; kept for a side-by-side check against the unpacked zip): E10: bottom-up Datalog, stratified NONE, semi-naive, magic sets, INCOMPLETE on budget overrun (never a negative answer). Plain Node, no install.',
  supports: new Set(['facts', 'select', 'open_world', 'classical_negation', 'rules', 'recursion', 'conflict', 'naf', 'closed_world', 'count', 'every', 'exists', 'conjunction', 'default', 'integrity', 'compare_in_rules', 'whatif', 'budget_probes', 'versions', 'overrides', 'strict_contrary', 'closed_derived']),
  async available() { return fs.existsSync(path.join(dir(), 'src/index.mjs')) ? {ok: true} : {ok: false, reason: 'unpacked E10 not found (unzip experiments/sop_reasoner_e10.zip into datasets_sources/experiments_unpacked/)'}; },
  async run(c, ctx) {
    const lab = await import(pathToFileURL(path.join(dir(), 'src/index.mjs')).href);
    const low = lowerToE10({knowledge: c.knowledge, query: c.query});
    const mode = f1(low.q, 'mode')?.value.trim() ?? 'select';
    if (['plan', 'abduce', 'why_not', 'explain'].includes(mode)) throw new NotExpressible(`mode ${mode} is not available in E10`);
    const where = [];
    for (const f of fAll(low.q, 'where')) for (const l of leaves(parseCondition(f, []))) {
      if (l.kind !== 'atom' || l.neg === 'absent') throw new NotExpressible('query condition not available in E10');
      where.push(l);
    }
    const options = {};
    if (low.policy.maxJoins) options.maxWork = low.policy.maxJoins;
    let incomplete = false;
    const ask = (gives, lines) => {
      const text = `${low.kb}\n@q query\nGIVES ${gives.join(' ')}\n${lines.join('\n')}\n`;
      ctx.lowered = text;
      const p = lab.parseSOP(text);
      const r = lab.reason(p, 'q', options);
      if (!r.complete) incomplete = true;
      return r;
    };
    const lit = (l, i, neg) => `${i === 0 ? 'MATCH' : 'AND'} ${neg ? 'NOT ' : ''}${l.neg === 'not' ? 'NOT ' : ''}${l.p} ${l.terms.join(' ')}`;
    const selectVars = f1(low.q, 'select') ? tokens(f1(low.q, 'select').value) : [...new Set(where.flatMap(l => varsOf(l.terms)))];
    const finish = o => ({...o, complete: !incomplete, conditional: low.supposed || undefined});
    if (mode === 'select' || mode === 'count') {
      const r = ask(selectVars, where.map((l, i) => lit(l, i, false)));
      const rows = (r.rows ?? []).map(row => Object.fromEntries(selectVars.map((v, k) => [v.replace(/^\?/, ''), row[k]])));
      if (!r.complete) return finish({status: 'budget_exhausted', rows: mode === 'select' ? rows : undefined});
      return finish(mode === 'count' ? {status: 'supported', count: rows.length} : {status: rows.length ? 'supported' : 'unknown', rows});
    }
    if (mode === 'exists') {
      const pos = ask([], where.map((l, i) => lit(l, i, false)));
      if (!pos.complete) return finish({status: 'budget_exhausted'});
      const ground = where.length === 1 && !where[0].terms.some(t => t.startsWith('?'));
      const neg = ground ? ask([], [lit(where[0], 0, true)]) : {rows: []};
      const p = pos.rows.length > 0, n = neg.rows.length > 0;
      return finish({status: p && n ? 'both' : p ? 'supported' : n ? 'refuted' : 'unknown'});
    }
    if (mode === 'every') {
      const scope = fAll(low.q, 'scope').flatMap(f => leaves(parseCondition(f, [])));
      const members = ask(selectVars.length ? selectVars : [...new Set(where.flatMap(l => varsOf(l.terms)))], where.map((l, i) => lit(l, i, false)));
      const cols = selectVars.length ? selectVars : [...new Set(where.flatMap(l => varsOf(l.terms)))];
      let refuted = false, unknown = false;
      for (const row of members.rows) {
        const sub = t => (t.startsWith('?') ? row[cols.indexOf(t)] : t);
        for (const s of scope) {
          const ground = {...s, terms: s.terms.map(sub)};
          const yes = ask([], [lit(ground, 0, false)]).rows.length > 0, no = ask([], [lit(ground, 0, true)]).rows.length > 0;
          if (no) refuted = true; else if (!yes) unknown = true;
        }
      }
      return finish({status: refuted ? 'refuted' : unknown ? 'unknown' : 'supported'});
    }
    throw new NotExpressible('mode ' + mode + ' not lowered');
  }
};
