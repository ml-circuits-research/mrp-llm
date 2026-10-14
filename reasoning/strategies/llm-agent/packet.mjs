/**
 * Strict parser of the model's answer into the result packet of proposal 5.3. Anything that is not exactly one JSON object of the
 * documented shape is an ERROR packet (`status: 'error'`, `reason: 'malformed_output'`); the parser never repairs, trims prose or guesses.
 * The only tolerance: one surrounding ```json fence with nothing else outside it.
 */
export const STATUSES = ['supported', 'refuted', 'both', 'unknown', 'entailed', 'possible', 'impossible', 'inconsistent', 'optimal', 'hypotheses', 'plan_found', 'blocked', 'no_plan', 'compliant', 'non_compliant', 'procedure_found', 'budget_exhausted'];

const isStr = x => typeof x === 'string';
const isInt = x => Number.isSafeInteger(x);
const isStrList = x => Array.isArray(x) && x.every(isStr);
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const scalar = v => isStr(v) || Number.isFinite(v);
const atomLists = x => Array.isArray(x) && x.every(isStrList);
const idList = x => Array.isArray(x) && x.every(v => isStr(v) || (isObj(v) && isStr(v.id)));

/** field -> validator. Unknown fields are dropped and noted. */
const FIELDS = {
  status: v => STATUSES.includes(v),
  complete: v => typeof v === 'boolean',
  rows: v => Array.isArray(v) && v.every(r => isObj(r) && Object.values(r).every(scalar)),
  count: isInt,
  bound: v => v === 'at_least',
  reason: isStr,
  witness: v => isObj(v) && Object.values(v).every(scalar),
  counterexample: v => isObj(v) && Object.values(v).every(scalar),
  objective: isInt,
  explain: v => isObj(v) && (v.depth === undefined || isInt(v.depth)) && (v.uses === undefined || isStrList(v.uses)),
  hypotheses: atomLists,
  missing: atomLists,
  blockers: isStrList,
  plan: v => isObj(v) && (v.cost === undefined || isInt(v.cost)) && (v.steps === undefined || isInt(v.steps)) && (v.names === undefined || isStrList(v.names)),
  relaxed: isStrList,
  obligations_triggered: isStrList,
  blocked_by: isStrList,
  blocked: v => isObj(v) && Object.values(v).every(isStr),
  contested: isStrList,
  compliance: v => isObj(v) && (v.hard === undefined || isStr(v.hard)) && (v.violated === undefined || isStrList(v.violated)) && (v.deviations === undefined || isStrList(v.deviations)) && (v.total_cost === undefined || isInt(v.total_cost)) && (v.soft_violations === undefined || (Array.isArray(v.soft_violations) && v.soft_violations.every(s => isObj(s) && isStr(s.id)))),
  procedure: v => isObj(v) && (v.id === undefined || isStr(v.id)) && (v.version === undefined || isInt(v.version)) && (v.steps === undefined || isStrList(v.steps)),
  conditional: v => v === true || isStrList(v),
  used: idList,
  explanation: isStr
};

function extractJson(text, marker) {
  let t = text;
  if (marker) {
    const i = t.lastIndexOf(marker);
    if (i < 0) throw new Error('the reply has no ' + marker + ' line');
    t = t.slice(i + marker.length);
  }
  t = t.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return fence ? fence[1] : t;
}

const error = (reason, detail) => ({status: 'error', reason, complete: true, detail});

/** With `marker` the JSON is the text after the LAST marker line (a missing marker is an error). Returns {ok: true, packet} or {ok: false, packet: error packet}. */
export function parseAnswer(text, marker = null) {
  let v;
  try { v = JSON.parse(extractJson(String(text ?? ''), marker)); }
  catch (e) { return {ok: false, packet: error('malformed_output', 'not one JSON object: ' + e.message.slice(0, 120))}; }
  if (!isObj(v)) return {ok: false, packet: error('malformed_output', 'the answer is not a JSON object')};
  if (!('status' in v)) return {ok: false, packet: error('malformed_output', 'no status field')};
  const out = {}, dropped = [];
  for (const [k, val] of Object.entries(v)) {
    if (!(k in FIELDS)) { dropped.push(k); continue; }
    if (!FIELDS[k](val)) return {ok: false, packet: error('malformed_output', `field ${k} has the wrong shape or an unknown value`)};
    out[k] = val;
  }
  if (out.used) out.used = out.used.map(u => (isStr(u) ? {id: u, version: 1} : {id: u.id, version: u.version ?? 1}));
  if (out.status === 'budget_exhausted') out.complete = false;
  else if (out.complete === undefined) out.complete = true;
  if (out.complete === false && out.status !== 'budget_exhausted' && !['supported'].includes(out.status)) return {ok: false, packet: error('malformed_output', 'complete false with a status that is not a budget status')};
  if (dropped.length) out.notes = [`dropped unknown fields: ${dropped.join(', ')}`];
  return {ok: true, packet: out};
}
