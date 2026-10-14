/**
 * The analysis procedures of a set of circuits (DS022 "Analysis procedures"). An analysis procedure is a `procedure` bundle wire whose
 * `scope` carries the tag `analysis`: its `members` are the rules, integrity constraints, defaults, aggregates and facts (parameters,
 * weights, reference data) that detect an issue, compute a KPI or score a rubric; its `report` lines (proposal P-8) are the atom patterns
 * whose rows it reports; without report lines it reports the violations of its integrity members. A procedure is exactly its members:
 * the analyzer runs those wires, nothing else of the memory, so an owner adds a domain procedure as data, with no code.
 *
 *   wireIndex(circuits)                        id → {id, type, text, circuit}: every wire block of the circuits, found by a line scan
 *                                              (cheap on a large base memory: only the blocks that are used are parsed)
 *   analysisProcedures(index, {ids})           the procedures: [{id, description, tags, members, reports, integrity, parameters, circuit}]
 *   memberLint(procedures, index)              [{code, procedure, wire, predicate, message}]: a member reads a predicate that only a
 *                                              non-member rule derives (the member would never fire), or names a missing wire
 */
import {parse, tokens, atomFrom} from '../../sop/knowledge/index.mjs';

export const ANALYSIS_TAG = 'analysis';
const DERIVING = new Set(['rule', 'default', 'aggregate']);
const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim() ?? null;
const fields = (w, key) => w.fields.filter(f => f.key === key).map(f => f.value.trim());
const decode = v => { try { return JSON.parse(v); } catch { return v ?? ''; } };
const fail = (message, code, status = 400) => Object.assign(new Error(message), {code, status});

/** Every wire block of the circuits by id (a later circuit's block with the same id replaces an earlier one). */
export function wireIndex(circuits) {
  const index = new Map();
  for (const c of circuits) {
    const lines = c.text.split('\n');
    let cur = null;
    const close = () => { if (cur) index.set(cur.id, {...cur, text: cur.lines.join('\n')}); };
    for (const line of lines) {
      const m = /^@(\S+)\s+(\S+)\s*$/.exec(line);
      if (m) { close(); cur = {id: m[1], type: m[2], circuit: c.name, lines: [line]}; }
      else if (cur && (line.startsWith('  ') || !line.trim())) cur.lines.push(line);
      else if (cur && line.startsWith('#')) continue;
      else { close(); cur = null; }
    }
    close();
  }
  for (const b of index.values()) delete b.lines;
  return index;
}

/** The parsed wire of an index entry (cached on the entry). */
export function wireOf(entry) {
  if (!entry) return null;
  if (!entry.wire) entry.wire = parse(entry.text).wires[0] ?? null;
  return entry.wire;
}

const tagsOf = w => String(decode(field(w, 'scope') ?? '""')).split(',').map(t => t.trim()).filter(Boolean);

/** The head predicate a deriving wire concludes. */
export function headPredicate(w) {
  const t = tokens(field(w, 'then') ?? field(w, 'yields') ?? '');
  return t[0] === 'not' ? t[1] : t[0] ?? null;
}

/**
 * The analysis procedures of an index. `ids`: the procedures to select (any procedure wire with report lines or integrity members may
 * be named); without `ids`, every procedure tagged `analysis`. An unknown or empty selection is an error.
 */
export function analysisProcedures(index, {ids = null} = {}) {
  const all = [...index.values()].filter(e => e.type === 'procedure').map(e => ({entry: e, wire: wireOf(e)})).filter(x => x.wire);
  const wanted = ids ? ids.map(id => {
    const hit = all.find(x => x.wire.id === id);
    if (!hit) throw fail(`Unknown analysis procedure ${JSON.stringify(id)}`, 'unknown_procedure', 404);
    return hit;
  }) : all.filter(x => tagsOf(x.wire).includes(ANALYSIS_TAG));
  return wanted.map(({entry, wire}) => {
    const members = fields(wire, 'members').flatMap(v => tokens(v)).map(t => t.replace(/^[$~]/, ''));
    const memberWires = members.map(id => wireOf(index.get(id))).filter(Boolean);
    const integrity = memberWires.filter(w => w.type === 'integrity').map(w => ({id: w.id, message: decode(field(w, 'message') ?? '""') || null, severity: field(w, 'severity') ?? 'error', source: decode(field(w, 'source') ?? '""') || null}));
    const parameters = memberWires.filter(w => w.type === 'fact').map(w => tokens(field(w, 'holds') ?? '')).filter(t => t[0] === 'analysis_parameter').map(t => ({name: t[1], value: Number.isNaN(Number(t[2])) ? decode(t[2]) : Number(t[2])}));
    const reports = fields(wire, 'report').map(text => {
      const a = atomFrom(tokens(text));
      if (a.error) throw fail(`report line of ${wire.id}: ${a.error}`, 'invalid_procedure', 422);
      return {text, predicate: a.p, terms: a.terms};
    });
    if (!reports.length && !integrity.length) throw fail(`Procedure ${wire.id} has neither report lines nor integrity members: it reports nothing`, 'invalid_procedure', 422);
    return {id: wire.id, description: decode(field(wire, 'description') ?? '""'), tags: tagsOf(wire), members, missing: members.filter(id => !index.has(id)), reports, integrity, parameters, circuit: entry.circuit};
  });
}

/**
 * Members that cannot do their work: a member wire that is missing, or a member that reads a predicate which only non-member rules of
 * the index derive (inside a run only members are applied, so that condition would never hold).
 */
export function memberLint(procedures, index) {
  const derivers = new Map();
  for (const e of index.values()) if (DERIVING.has(e.type)) {
    const w = wireOf(e);
    const h = w && headPredicate(w);
    if (h) { if (!derivers.has(h)) derivers.set(h, []); derivers.get(h).push(w.id); }
  }
  const out = [];
  for (const p of procedures) {
    const members = new Set(p.members);
    for (const id of p.missing) out.push({code: 'member_missing', procedure: p.id, wire: id, message: `member ${id} of ${p.id} is not in the memory`});
    for (const id of p.members) {
      const w = wireOf(index.get(id));
      if (!w || !['rule', 'default', 'aggregate', 'integrity'].includes(w.type)) continue;
      for (const key of ['when', 'over', 'never']) for (const f of w.fields.filter(x => x.key === key)) {
        const texts = f.block?.length ? f.block.map(b => b.text) : [f.value];
        for (const t of texts) {
          const toks = tokens(t);
          const pred = ['not', 'absent'].includes(toks[0]) ? toks[1] : toks[0];
          if (!pred || ['all', 'any', 'end', 'compare', 'compute', 'order', 'start_of', 'end_of', 'match'].includes(pred)) continue;
          const by = derivers.get(pred);
          if (by?.length && !by.some(d => members.has(d))) out.push({code: 'member_dependency_missing', procedure: p.id, wire: id, predicate: pred, message: `${id} reads ${pred}, which only ${by.slice(0, 3).join(', ')} derive(s); add the deriving wire to the members of ${p.id}`});
        }
      }
    }
  }
  return out;
}
