/**
 * Time (snapshot semantics, 4.2 item 7). A fact has `valid timeless` (default) or `valid START END` (start inclusive, end
 * exclusive). At an instant `t` a stored fact holds iff its interval contains `t`, and a derived atom holds at `t` iff some rule
 * instance has its whole body holding at that same `t`: the oracle filters the stored facts to the instant and closes the filtered
 * view, so derived validity is the intersection of the validities of the body facts for free.
 *
 *   at T           one instant;
 *   during S E     THROUGHOUT: every instant of [S, E);
 *   overlaps S E   SOME instant of [S, E);
 *   (nothing)      no filter: every stored fact is in the view (the validity is data for start_of / end_of).
 *
 * An interval is partitioned at every endpoint of a stored fact inside it; the answer for a part is the same for all of its
 * instants, so one closure per part (at the part's first instant) decides the interval; the parts are combined by query.mjs.
 */
import {parseInstant, validAt} from './values.mjs';

export function timeParts(facts, q) {
  if (q.at) return {how: null, instants: [parseInstant(q.at)]};
  const span = q.during ?? q.overlaps;
  if (!span) return {how: null, instants: [null]};
  const [s, e] = span.map(parseInstant);
  const cuts = new Set();
  for (const f of facts) if (f.valid) for (const t of [f.valid.from, f.valid.to]) if (t > s && t < e) cuts.add(t);
  return {how: q.during ? 'throughout' : 'some', instants: [s, ...[...cuts].sort((a, b) => a - b)]};
}

export const viewAt = (facts, t) => (t === null ? facts : facts.filter(f => validAt(f.valid, t)));
