/**
 * `used`: ONE SUFFICIENT SUPPORT SET (round 3, MUST-FIX 3 of review round 2).
 *
 * Deletion alone is wrong: with two facts that are each sufficient, deleting either leaves the answer unchanged, so the
 * deletion set is empty although the answer certainly rests on one of them. So:
 *   - a strategy that provides `used` returns the leaves of one proof (a sufficient set);
 *   - for the others the host runs the DELETION method (leave-one-out over facts, rules and defaults) and VERIFIES it by a
 *     replay run on the claims of the set alone. If the replay re-derives the answer, the set is sufficient (`used`);
 *     otherwise `used_incomplete: true` (a flag distinct from `conditional_unknown`);
 *   - the shadow comparator replays any strategy's `used` alone in the oracle and compares STATUSES (and rows), never leaf sets.
 * Under-reporting `used` only loses proof-use promotions (AGENTS.md rule 7); it never invents a claim.
 */
import {parse} from '../validator.mjs';
import {wireText} from './desugar.mjs';

const CLAIM_TYPES = ['fact', 'rule', 'default'];
const f1 = (w, k) => w.fields.find(f => f.key === k)?.value.trim();
const sig = r => JSON.stringify({status: r.status, rows: (r.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort(), count: r.count});

function keepClaims(knowledge, keep) {
  const {wires} = parse(knowledge);
  return wires.filter(w => !CLAIM_TYPES.includes(w.type) || keep.includes(w.id)).map(wireText).join('\n\n') + '\n';
}

export const claimIds = knowledge => parse(knowledge).wires.filter(w => CLAIM_TYPES.includes(w.type) && !['supposed', 'hedged', 'reported'].includes(f1(w, 'status'))).map(w => w.id);

/** The host's deletion method plus the verifying replay. `run` executes a case and returns a normalized result. */
export async function hostUsed(run, c, full) {
  const ids = claimIds(c.knowledge);
  const needed = [];
  for (const id of ids) if (sig(await run({...c, knowledge: keepClaims(c.knowledge, ids.filter(x => x !== id))})) !== sig(full)) needed.push(id);
  const replay = await run({...c, knowledge: keepClaims(c.knowledge, needed)});
  const ok = sig(replay) === sig(full);
  return {used: needed.map(id => ({id, version: Number(f1(parse(c.knowledge).wires.find(w => w.id === id), 'version') ?? 1)})), used_incomplete: !ok};
}

/** Replay a strategy's `used` alone in the oracle: it must re-derive the answer (statuses and rows), never match leaf sets. */
export async function replayUsed(oracleRun, c, got) {
  if (got.used_incomplete || !got.used) return {ok: true, skipped: true};
  const keep = got.used.map(u => u.id);
  const res = await oracleRun({...c, knowledge: keepClaims(c.knowledge, keep)});
  const rows = r => JSON.stringify((r.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort());
  return res.status === got.status && rows(res) === rows(got) ? {ok: true} : {ok: false, why: `oracle on used ${JSON.stringify(keep)} gives ${res.status}${res.rows ? ' ' + JSON.stringify(res.rows) : ''}, the strategy said ${got.status}`};
}
