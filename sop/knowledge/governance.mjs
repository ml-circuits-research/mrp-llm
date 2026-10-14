/**
 * Governance: which wires are IN FORCE for a query (DS004 "Governance").
 *
 * Governed wires (rule, default, integrity, method, norm) carry `version`, `supersedes`, `approval`
 * (proposed | approved | contested | rejected | superseded | retired), `approved_by`, `approved_at`, `retired_at`. In MEMORY a wire
 * without an `approval` field is approved: ingestion is the approval and writes the field (on the AUTHORING surface an omitted
 * approval means submitted, i.e. proposed; the case files of this suite are stated as memory content). Approved wires bind, and
 * so does a `contested` wire, FLAGGED (`contestedIds`) until the host rules on the contest. `proposed` and `rejected`
 * wires enter the theory only when the query supposes them (`if $id`): they are then used like supposed facts, and the answer
 * is conditional on them.
 * `asof` selects the version known at that date: a wire is in force from its `approved_at` until its successor's
 * `approved_at` (or its `retired_at`).
 */
import {tokens} from './lexical.mjs';

export const GOVERNED = ['rule', 'default', 'integrity', 'method', 'norm', 'action'];
const f1 = (w, k) => w.fields.find(f => f.key === k)?.value.trim();

export function selectInForce(wires, {asof = null, include = []} = {}) {
  const successors = new Map();
  for (const w of wires) { const s = f1(w, 'supersedes'); if (s) (successors.get(s.slice(1)) ?? successors.set(s.slice(1), []).get(s.slice(1))).push(w); }
  const ok = w => {
    if (!GOVERNED.includes(w.type)) return true;
    if (include.includes(w.id)) return true;
    const approval = f1(w, 'approval') ?? 'approved';
    if (approval === 'proposed' || approval === 'rejected') return false;
    if ((successors.get(w.id) ?? []).some(s => include.includes(s.id))) return false; // superseded by a wire the query supposes
    if (asof === null) return approval === 'approved' || approval === 'contested';
    const at = f1(w, 'approved_at');
    if (at && at > asof) return false;
    if (approval === 'approved' || approval === 'contested') return true;
    if (approval === 'superseded') return (successors.get(w.id) ?? []).every(s => { const sa = f1(s, 'approved_at'); return !sa || sa > asof; });
    const end = f1(w, 'retired_at');
    return Boolean(end) && end > asof;
  };
  return wires.filter(ok);
}

/** Wires that bind while contested: the packet flags them (`contested: [ids]`) until the host rules. */
export const contestedIds = wires => wires.filter(w => GOVERNED.includes(w.type) && f1(w, 'approval') === 'contested').map(w => w.id);

/** The ids of the governed wires a query supposes (`if $id` that names a wire which is not a fact). */
export function supposedWireIds(queryWires, knowledgeWires) {
  const ids = [];
  for (const q of queryWires.filter(w => w.type === 'query')) for (const f of q.fields.filter(x => x.key === 'if')) { const id = f.value.trim().slice(1); const w = knowledgeWires.find(x => x.id === id); if (w && GOVERNED.includes(w.type)) ids.push(id); else if (w && w.type === 'amendment') for (const m of w.fields.filter(x => x.key === 'members')) for (const t of tokens(m.value)) ids.push(t.slice(1)); }
  return ids;
}
