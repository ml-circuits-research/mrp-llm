/**
 * Test helper: turn one of VRC's exported tabled-Prolog programs (datasets_sources/experiments_unpacked/vrc03r/vrc03/exports/*.pl, the
 * pure relational subset: facts, Horn rules, `\+` over a base predicate, `>=`) back into reasoning circuits and a query, so that the
 * strategies can be checked against the row counts SWI-Prolog computes for the original file.
 */
const splitTop = (s) => {
  const out = []; let depth = 0, cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") inQ = !inQ;
    if (!inQ && c === '(') depth++;
    if (!inQ && c === ')') depth--;
    if (!inQ && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const arg = a => {
  a = a.trim();
  if (a.startsWith('V_')) return '?' + a.slice(2);
  if (a.startsWith("'")) { const v = a.slice(1, -1); return /^[a-z][a-z0-9_]*$/.test(v) ? v : JSON.stringify(v); }
  return a;
};
const atomOf = g => { const m = /^(\\\+\s*)?(p\d+)\((.*)\)$/s.exec(g.trim()); if (!m) return null; return {neg: Boolean(m[1]), p: m[2], args: splitTop(m[3]).map(arg)}; };

export function circuitsOfPl(text) {
  const lines = text.split('\n');
  const arity = new Map(), facts = [], rules = [], negated = new Set();
  let query = null;
  for (const line of lines) {
    const fm = /^(p\d+)\((.*)\)\.$/.exec(line);
    if (fm && !fm[2].includes('V_')) { const args = splitTop(fm[2]).map(arg); arity.set(fm[1], args.length); facts.push({p: fm[1], args}); continue; }
    const rm = /^(p\d+\(.*?\)) :- (.*)\.$/.exec(line);
    if (rm && !line.startsWith('run(')) {
      const head = atomOf(rm[1]);
      const body = splitTop(rm[2]).map(g => {
        const a = atomOf(g);
        if (a) { if (a.neg) negated.add(a.p); return a; }
        const c = /^V_(\w+)\s*(>=|=<|>|<|=:=|=\\=)\s*(-?\d+)$/.exec(g.trim());
        if (c) return {cmp: ({'>=': 'at_least', '=<': 'at_most', '>': 'above', '<': 'below', '=:=': 'equal', '=\\=': 'not_equal'})[c[2]], left: '?' + c[1], right: c[3]};
        throw new Error('unsupported goal ' + g);
      });
      rules.push({head, body});
      continue;
    }
    const qm = /^run\(Rows,Ms\) :- .*findall\(\[([^\]]*)\], (p\d+)\(([^)]*)\), Raw\)/.exec(line);
    if (qm) query = {vars: qm[1].split(',').map(v => '?' + v.trim().slice(2)), p: qm[2], args: splitTop(qm[3]).map(arg)};
  }
  for (const r of rules) { arity.set(r.head.p, r.head.args.length); for (const b of r.body) if (b.p) arity.set(b.p, b.args.length); }
  let k = '';
  for (const [p, n] of arity) k += `@${p} predicate\n  args ${Array(n).fill('subject:entity').join(' ')}\n${negated.has(p) ? '  closed true\n' : ''}`;
  facts.forEach((f, i) => { k += `@f${i} fact\n  holds ${f.p} ${f.args.join(' ')}\n`; });
  rules.forEach((r, i) => {
    k += `@r${i} rule\n`;
    for (const b of r.body) k += b.cmp ? `  when compare ${b.left} ${b.cmp} ${b.right}\n` : `  when ${b.neg ? 'absent ' : ''}${b.p} ${b.args.join(' ')}\n`;
    k += `  then ${r.head.p} ${r.head.args.join(' ')}\n`;
  });
  return {knowledge: k, query: `@q query\n  where ${query.p} ${query.args.join(' ')}\n  select ${query.vars.join(' ')}\n`, expectedVars: query.vars};
}
