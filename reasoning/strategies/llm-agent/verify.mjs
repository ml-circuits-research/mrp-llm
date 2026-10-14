/**
 * Optional verify mode: re-check the model's claimed `used` support in the js-oracle. The claims (facts, rules, defaults) of the knowledge
 * that are NOT in `used` are removed, the oracle answers the same query, and a row is `verified` when the oracle re-derives it from the claimed
 * support alone. The result never makes the answer exact: it is evidence that the cited support is sufficient, and `verified: null`
 * says the oracle could not decide (not expressible, invalid circuit).
 */
import {jsReference} from '../js-reference/index.mjs';

const CLAIM_TYPES = new Set(['fact', 'rule', 'default']);

/** Split SOP text into wire blocks at lines that start with "@". */
export function wireBlocks(text) {
  const blocks = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('@')) blocks.push({head: line, lines: [line]});
    else if (blocks.length) blocks.at(-1).lines.push(line);
  }
  return blocks.map(b => ({id: b.head.slice(1).split(/\s+/)[0], type: b.head.split(/\s+/)[1], text: b.lines.join('\n').trimEnd()}));
}

export function keepClaims(knowledge, keepIds) {
  const keep = new Set(keepIds);
  return wireBlocks(knowledge).filter(b => !CLAIM_TYPES.has(b.type) || keep.has(b.id)).map(b => b.text).join('\n\n') + '\n';
}

const rowKey = r => JSON.stringify(Object.entries(r).map(([k, v]) => [k, String(v)]).sort());

export function verifyUsed({knowledge, query}, packet) {
  if (!packet.used?.length) return {verified: null, note: 'no used list to verify'};
  let replay;
  try { replay = jsReference.ask({theory: {knowledge: keepClaims(knowledge, packet.used.map(u => u.id))}, query}); }
  catch (e) { return {verified: null, note: 'oracle could not replay: ' + e.message.split('\n')[0]}; }
  const verified = replay.status === packet.status && (packet.count === undefined || replay.count === packet.count) && (packet.rows === undefined || (replay.rows ?? []).length === packet.rows.length);
  const have = new Set((replay.rows ?? []).map(rowKey));
  const rowVerified = (packet.rows ?? []).map(row => ({row, verified: have.has(rowKey(row))}));
  return {verified: verified && rowVerified.every(r => r.verified), replay_status: replay.status, row_verified: packet.rows ? rowVerified : undefined};
}
