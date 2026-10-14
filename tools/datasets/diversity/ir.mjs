/** Intermediate representations of one row.
 *
 * Canonical IR (verification only, never shown to the model): predicate ids, domain roles and entity ids; it
 * drives the verification world (setup_sop, ontology_sop) against which the linked target is executed.
 *
 * Surface IR (the model target): what the message says, as strings.
 *   {
 *     stated:  [{relation: "work at", roles: [[closedRole, "\"Maria\""]], polarity, certainty, speaker?}],
 *     assumed: [{relation, roles, polarity, basis?}],
 *     unclear: {kind: 'gibberish'|'no_request'} | null,
 *     query:   {ask: 'whether'|'which'|'count'|'every'|'explain', select: ['?x'], props: [proposition with ?variables],
 *               scope: [propositions that must hold for every binding of props] (ask every),
 *               measure: 'start'|'end'|'duration' (a selected `role time ?t`), filter: ['?x != "Ana"'] (printed as
 *               `except ?x "Ana"`), compare: [['?v', 'above', '80']], rank: ['highest'|'lowest', '?v'],
 *               quantifier: 'all'|'none'|'not_all'|'most'|'half'|'at_least N' (ask every),
 *               order: ['?t1', 'before'|'after'|'same_time', '?t2'], fragment: 'follow_up' (props may omit the
 *               relation)} | null,
 *     constraint: {task, vars, require, claim} | null,
 *   }
 * Role values are JSON-quoted strings exactly as mentioned in the message, or ?variables. Closed roles:
 * subject, object, recipient, location, source, destination, instrument, time, topic. Printers (printers.mjs)
 * turn a surface IR into target text; the exact grammar is owned by the language profile (DS014).
 */
import { PREDICATES, CLOSED_ROLES } from './domains.mjs';

export const POLARITIES = new Set(['affirmed', 'negated']);
export const CERTAINTIES = new Set(['asserted', 'hedged', 'supposed']);
export const BASES = new Set(['closure', 'default', 'disambiguation', 'implicature', 'world']);
export const UNCLEAR_KINDS = ['gibberish', 'no_request', 'ambiguous'];
export const ASKS = ['whether', 'which', 'count', 'every', 'explain'];

export const emptySurface = () => ({ stated: [], assumed: [], unclear: null, query: null, constraint: null });
export const emptyCanon = () => ({ stated: [], assumed: [], query: null, constraint: null });

/** Canonical proposition from a predicate id and {domainRole: entity}; args in declared role order. */
export function canonical(relation, bindings, { polarity = 'affirmed', time = { valid: 'timeless' } } = {}) {
  const spec = PREDICATES[relation];
  if (!spec) throw Error(`Unknown predicate ${relation}`);
  const args = spec.roles.map(([name]) => {
    const value = bindings[name];
    if (value === undefined) throw Error(`${relation}: missing role ${name}`);
    return typeof value === 'string' ? value : value.id;
  });
  return { relation, bindings, args, polarity, time };
}
/** Positional atom of a canonical proposition, e.g. `works_at ana acme` (with `not` when negated). */
export const atomOf = prop => `${prop.polarity === 'negated' ? 'not ' : ''}${prop.relation} ${prop.args.join(' ')}`;

export const COMPARATORS = new Set(['above', 'below', 'at_least', 'at_most', 'equal', 'not_equal']);
export const QUANTIFIERS = /^(all|none|not_all|most|half|at_least \d+)$/;
export const ORDERS = new Set(['before', 'after', 'same_time']);
const checkProp = (p, { ground, fragment = false }) => {
  if (!(fragment && p.relation === undefined) && (typeof p.relation !== 'string' || !p.relation.trim())) throw Error('Proposition without relation phrase');
  if (!POLARITIES.has(p.polarity)) throw Error(`Bad polarity ${p.polarity}`);
  if (!fragment && !p.roles.some(([role]) => role === 'subject')) throw Error(`${p.relation}: no subject`);
  for (const [role, value] of p.roles) {
    if (!CLOSED_ROLES.includes(role)) throw Error(`${p.relation}: role ${role} is not in the closed set`);
    if (ground && !/^"/.test(value)) throw Error(`${p.relation}: ${role} must be a quoted string in a statement`);
    if (!/^"|^\?[a-z]\w*$|^-?\d+$/.test(value)) throw Error(`${p.relation}: bad value ${value}`);
  }
  const roles = p.roles.map(([role]) => role);
  if (new Set(roles).size !== roles.length) throw Error(`${p.relation}: repeated role`);
};

/** Structural checks shared by every printer; throws on an ill-formed surface IR. */
export function validateSurface(ir) {
  if (ir.unclear) {
    if (!UNCLEAR_KINDS.includes(ir.unclear.kind)) throw Error(`Unknown unclear kind ${ir.unclear.kind}`);
    const readings = ir.unclear.readings ?? [];
    if ((ir.unclear.kind === 'ambiguous') !== (readings.length > 0)) throw Error('readings belong to unclear kind ambiguous');
    if (readings.length && (readings.length < 2 || readings.length > 4 || readings.some(r => !/^"/.test(r) || !JSON.parse(r).trim()))) throw Error('ambiguous lists 2..4 quoted readings');
    if (ir.stated.length || ir.assumed.length || ir.query || ir.constraint) throw Error('unclear must be the only content');
    return ir;
  }
  for (const p of ir.stated) { checkProp(p, { ground: true }); if (!CERTAINTIES.has(p.certainty)) throw Error(`Bad certainty ${p.certainty}`); }
  for (const p of ir.assumed) { checkProp(p, { ground: true }); if (p.basis && !BASES.has(p.basis)) throw Error(`Bad basis ${p.basis}`); }
  if (!ir.query && !ir.constraint && !ir.stated.length) throw Error('Surface IR states nothing and asks nothing');
  for (const q of [ir.query, ...(ir.moreQueries ?? [])].filter(Boolean)) {
    if (!ASKS.includes(q.ask)) throw Error(`Bad ask ${q.ask}`);
    if (['which', 'count'].includes(q.ask) && !q.select?.length) throw Error('which/count need select');
    if (q.ask === 'explain' && q.select?.length) throw Error('explain selects nothing');
    if ((q.ask === 'every') !== Boolean(q.scope?.length)) throw Error('every needs a scope and only every has one');
    if (!q.props?.length) throw Error('query needs at least one proposition');
    for (const p of [...q.props, ...(q.scope ?? [])]) checkProp(p, { ground: false, fragment: Boolean(q.fragment) });
    const times = new Set([...q.props, ...(q.scope ?? [])].flatMap(p => p.roles.filter(([role, value]) => role === 'time' && value.startsWith('?')).map(([, value]) => value)));
    // Two time variables only with an ordering between them (Q-LANG-3).
    if (times.size > (q.order ? 2 : 1)) throw Error('at most one time variable per query (two with order)');
    for (const [variable, comparator, operand] of q.compare ?? []) if (!/^\?[a-z]\w*$/.test(variable) || !COMPARATORS.has(comparator) || !/^"|^\?[a-z]\w*$|^-?\d+$/.test(operand)) throw Error(`bad compare ${variable} ${comparator} ${operand}`);
    if (q.rank && !(['highest', 'lowest'].includes(q.rank[0]) && /^\?[a-z]\w*$/.test(q.rank[1]))) throw Error(`bad rank ${q.rank}`);
    if (q.quantifier && (q.ask !== 'every' || !QUANTIFIERS.test(q.quantifier))) throw Error(`quantifier ${q.quantifier} needs ask every`);
    if (q.order && !(times.has(q.order[0]) && ORDERS.has(q.order[1]) && times.has(q.order[2]))) throw Error(`order needs two time variables: ${q.order}`);
    if (q.fragment && q.fragment !== 'follow_up') throw Error(`bad fragment ${q.fragment}`);
    if (q.measure && !(times.has(q.select?.[0]) && q.select.length === 1)) throw Error('measure needs the selected time variable');
  }
  return ir;
}

/** Target skeleton: wire types, ask, closed-role sets, polarity and variables, independent of the strings. */
export function surfaceSkeleton(ir) {
  if (ir.unclear) return `unclear:${ir.unclear.kind}${ir.unclear.readings ? ':' + ir.unclear.readings.length : ''}`;
  const shape = p => `${p.polarity === 'negated' ? '!' : ''}[${p.roles.map(([role, value]) => `${role}${value.startsWith('?') ? '?' : ''}`).join(',')}]`;
  const parts = [
    ...ir.stated.map(p => `S${shape(p)}${p.certainty !== 'asserted' ? '~' + p.certainty : ''}${p.speaker ? '+spk' : ''}`),
    ...ir.assumed.map(p => `A${shape(p)}${p.basis ? '~' + p.basis : ''}`),
  ];
  const query = q => `Q:${q.ask}${q.quantifier ? ':' + q.quantifier.split(' ')[0] : ''}${q.fragment ? ':fragment' : ''}${q.compare?.length ? '+cmp' : ''}${q.rank ? '+rank' : ''}${q.order ? '+order' : ''}${q.measure ? ':' + q.measure : ''}(${q.props.map(shape).join('&')})${q.scope ? `/(${q.scope.map(shape).join('&')})` : ''}${q.select?.length > 1 ? '+sel' + q.select.length : ''}${q.filter?.length ? '+f' : ''}${q.props.some(p => p.queryTime) || q.time ? '+t' : ''}${q.asof ? '+asof' : ''}`;
  if (ir.query) parts.push(query(ir.query));
  for (const q of ir.moreQueries ?? []) parts.push(query(q));
  if (ir.constraint) parts.push(`C:${ir.constraint.task}:${ir.constraint.require.length}`);
  return parts.join(' ');
}
