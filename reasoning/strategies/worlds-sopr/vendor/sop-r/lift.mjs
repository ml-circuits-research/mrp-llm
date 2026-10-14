// VENDORED: copied verbatim from sop-r.zip src/ lift.mjs
// Rule lifting ("rules as data").
//
// An LLM compiling many documents tends to emit thousands of rules that differ only in constants:
//     when ?t holds-species arctic-char / then ?t density-limit 35
//     when ?t holds-species atlantic-salmon / then ?t density-limit 20   ... x 10^5
// Such a family is rewritten into ONE template rule plus a parameter table stored as ordinary facts:
//     @lift-1 rule
//       when ?_linst lift-1-p1 ?_lp1
//       when ?_linst lift-1-p2 ?_lp2
//       when ?t holds-species ?_lp1
//       then ?t density-limit ?_lp2
//     @lift-1-params fact
//       say lift-1-i1 lift-1-p1 arctic-char
//       say lift-1-i1 lift-1-p2 35 ...
// The rule index then holds one entry instead of 10^5, and "which rule applies to X" becomes an
// indexed fact lookup. The rewrite is exact: instance k of the template reproduces rule k.
import { Wire, Line } from './parse.mjs';
import { isVar, isRef, Quoted, fmtTok, tokKey } from './lex.mjs';

const PATTERN_KWS = new Set(['when', 'match', 'unless', 'not', 'then']);
const LIFTABLE_KWS = new Set(['when', 'match', 'unless', 'not', 'then', 'let', 'test', 'from', 'note', 'source']);

function signature(w) {
  const ren = new Map();
  const rv = (x) => { if (!ren.has(x)) ren.set(x, '?v' + ren.size); return ren.get(x); };
  const consts = [];
  const parts = [];
  for (const l of w.lines) {
    if (l.kw === 'note' || l.kw === 'source') continue;
    if (PATTERN_KWS.has(l.kw) && l.args.length === 3) {
      const a = l.args.map((x, i) => {
        if (isVar(x)) return rv(x);
        if (i === 1) return 'R:' + tokKey(x);
        consts.push(x);
        return '#';
      });
      parts.push(l.kw + ' ' + a.join(' '));
    } else {
      parts.push(l.kw + ' ' + l.args.map((x) => (isVar(x) ? rv(x) : 'K:' + tokKey(x))).join(' '));
    }
  }
  return { sig: parts.join(' | '), consts };
}

export function liftWires(wires, opts = {}) {
  const min = opts.liftMin || 3;
  const referenced = new Set(), superseded = new Set();
  for (const w of wires) for (const l of w.lines) {
    if ((l.kw === 'overrides' || l.kw === 'supersedes') && l.args.length === 1 && isRef(l.args[0])) {
      referenced.add(l.args[0].slice(1));
      if (l.kw === 'supersedes') superseded.add(l.args[0].slice(1));
    }
  }
  const names = new Set(wires.map((w) => w.name));
  const fams = new Map();
  for (const w of wires) {
    if (w.type !== 'rule' || w.origin === 'prelude' || referenced.has(w.name)) continue;
    if (w.lines.some((l) => !LIFTABLE_KWS.has(l.kw))) continue;
    const { sig, consts } = signature(w);
    if (!consts.length) continue;
    if (!fams.has(sig)) fams.set(sig, []);
    fams.get(sig).push({ w, consts });
  }
  const drop = new Set();
  const added = [];
  const report = [];
  let n = 0;
  for (const [sig, members] of fams) {
    if (members.length < min) continue;
    let base;
    do { n++; base = `lift-${n}`; } while (names.has(base) || names.has(base + '-params'));
    const k = members[0].consts.length;
    const varying = [];
    for (let i = 0; i < k; i++) {
      const v0 = tokKey(members[0].consts[i]);
      if (members.some((m) => tokKey(m.consts[i]) !== v0)) varying.push(i);
    }
    const pnum = new Map(varying.map((i, j) => [i, j + 1]));
    const first = members[0].w;
    const tpl = new Wire(base, 'rule', first.origin, first.n);
    tpl.lines.push(new Line('note', [new Quoted(`lifted from ${members.length} rules (${members[0].w.name} ... ${members[members.length - 1].w.name})`)], first.n, ''));
    for (let j = 1; j <= varying.length; j++) tpl.lines.push(new Line('when', ['?_linst', `${base}-p${j}`, `?_lp${j}`], first.n, ''));
    let ci = 0;
    for (const l of first.lines) {
      if (l.kw === 'note' || l.kw === 'source') continue;
      if (PATTERN_KWS.has(l.kw) && l.args.length === 3) {
        const a = l.args.map((x, i) => {
          if (isVar(x) || i === 1) return x;
          const idx = ci++;
          return pnum.has(idx) ? `?_lp${pnum.get(idx)}` : x;
        });
        tpl.lines.push(new Line(l.kw, a, l.n, ''));
      } else tpl.lines.push(new Line(l.kw, l.args, l.n, l.raw));
    }
    const params = new Wire(base + '-params', 'fact', first.origin, first.n);
    members.forEach((m, i) => {
      for (const [idx, j] of pnum) params.lines.push(new Line('say', [`${base}-i${i + 1}`, `${base}-p${j}`, m.consts[idx]], m.w.n, ''));
      drop.add(m.w.name);
    });
    added.push({ after: first.name, wires: [tpl, params] });
    report.push(`@${base}: ${members.length} rules -> 1 template + ${members.length * varying.length} parameter facts (${varying.length} parameters)`);
  }
  const out = [];
  const byFirst = new Map(added.map((a) => [a.after, a.wires]));
  for (const w of wires) {
    if (byFirst.has(w.name)) out.push(...byFirst.get(w.name));
    if (!drop.has(w.name)) out.push(w);
  }
  return { wires: out, report };
}

const RAW_KWS = new Set(['let', 'test', 'require-test']);
export function formatWires(wires) {
  const out = [];
  for (const w of wires) {
    if (w.origin === 'prelude') continue;
    out.push(`@${w.name} ${w.type}`);
    for (const l of w.lines) out.push(`  ${l.kw}${RAW_KWS.has(l.kw) && l.raw ? ' ' + l.raw : l.args.length ? ' ' + l.args.map(fmtTok).join(' ') : ''}`);
  }
  return out.join('\n') + '\n';
}
