/**
 * `used` for a strategy that does not build proofs: the host's DELETION method plus a verifying replay (proposal 5.3, round 3).
 *
 * `used` is ONE SUFFICIENT SUPPORT SET. Deletion alone is wrong when two claims are each sufficient (deleting either changes
 * nothing, so the set would be empty), so the set found by deletion is replayed ALONE through the same strategy: if the replay gives
 * the same answer the set is sufficient and is `used`; otherwise the packet says `used_incomplete: true` and promotes nothing.
 * Under-reporting `used` only loses proof-use promotions (AGENTS.md rule 7); it never invents a claim.
 * The cost is one solver run per claim of the circuits, so a very large set is reported as `used_incomplete` instead of being run.
 */
const CLAIM_TYPES = ['fact', 'rule', 'default', 'aggregate'];
const ASSUMED = ['supposed', 'hedged', 'reported'];
const MAX_CLAIMS = 60;
const f1 = (w, k) => w.fields.find(f => f.key === k)?.value.trim();
const rowKey = x => JSON.stringify(Object.entries(x).sort());
const signature = r => JSON.stringify({status: r.status, rows: (r.rows ?? []).map(rowKey).sort(), count: r.count});

export function usedByDeletion({handle, solve, packet, versionOf}) {
  const claims = handle.wires.filter(w => CLAIM_TYPES.includes(w.type) && !ASSUMED.includes(f1(w, 'status')));
  if (claims.length > MAX_CLAIMS) return {used: [], used_incomplete: true};
  const target = signature(packet);
  const without = ids => ({...handle, wires: handle.wires.filter(w => !ids.includes(w.id)), knowledge: undefined});
  const run = ids => { try { return signature(solve(without(ids), new Set())); } catch { return null; } };
  const needed = claims.filter(c => run([c.id]) !== target).map(c => c.id);
  const replay = run(claims.map(c => c.id).filter(id => !needed.includes(id)));
  return {used: needed.map(id => ({id, version: versionOf(id)})), ...(replay === target ? {} : {used_incomplete: true})};
}
