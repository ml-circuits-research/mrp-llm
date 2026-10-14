/** Target printers: surface IR → target text. The registry is pluggable (`registerPrinter`), so a change of
 * the SOP surface is a new printer, not a generator change.
 *
 * `strings` follows the grammar of sop/parser.mjs (DS014): `stated`/`assumed` with a quoted `relation`
 * phrase, closed-role `role NAME "value"` lines, `polarity`, optional `valid on|from|until "text"`, then
 * `certainty`/`speaker` (stated) or `basis` (assumed); `unclear` with `kind`, alone; a `query` whose `where`
 * holds one `match … end` block or an `all` group of them, with `select`, `mode`, `measure`, `filter`, a
 * `scope` block for `mode every` and `at|during|asof "text"`; `constraint` with `task`. Values are quoted exactly as written in the message.
 */
import { validateSurface } from './ir.mjs';

const validLines = (p, indent) => Object.entries(p.valid ?? {}).map(([form, text]) => `${indent}valid ${form} ${text}`);
// A fragment's match block may carry no relation (Q-LANG-4): only the roles the message has.
const propositionLines = (p, indent = '  ', { validity = true } = {}) => [...(p.relation === undefined ? [] : [`${indent}relation ${JSON.stringify(p.relation)}`]), ...p.roles.map(([role, value]) => `${indent}role ${role} ${value}`), `${indent}polarity ${p.polarity}`, ...(validity ? validLines(p, indent) : [])];
const matchBlock = (p, indent) => [`${indent}match`, ...propositionLines(p, indent + '  ', { validity: false }), `${indent}end`];

const condition = (key, props) => props.length === 1 ? [`  ${key} match`, ...propositionLines(props[0], '    ', { validity: false }), '  end'] : [`  ${key} all`, ...props.flatMap(p => matchBlock(p, '    ')), '  end'];
const queryWire = (q, id) => {
  const variables = q.props.some(p => p.roles.some(([, v]) => v.startsWith('?')));
  const lines = [`@${id} query`];
  if (q.fragment) lines.push(`  fragment ${q.fragment}`);
  if (q.ask === 'count') lines.push('  mode count');
  else if (q.ask === 'every') lines.push('  mode every');
  else if (q.ask === 'explain') lines.push('  mode explain');
  else if (q.ask === 'whether' && variables) lines.push('  mode exists');
  if (q.quantifier) lines.push(`  quantifier ${q.quantifier}`);
  if (q.asof) lines.push(`  asof ${q.asof}`);
  if (q.select?.length) lines.push(`  select ${q.select.join(' ')}`);
  if (q.measure) lines.push(`  measure ${q.measure}`);
  if (q.rank) lines.push(`  rank ${q.rank[0]} ${q.rank[1]}`);
  lines.push(...condition('where', q.props));
  if (q.scope?.length) lines.push(...condition('scope', q.scope));
  // Model targets use words, never operator symbols (owner principle): `except ?x "Ana"`, `compare ?v above 80`.
  for (const filter of q.filter ?? []) lines.push(`  ${exceptLine(filter)}`);
  for (const [variable, comparator, operand] of q.compare ?? []) lines.push(`  compare ${variable} ${comparator} ${operand}`);
  if (q.order) lines.push(`  order ${q.order.join(' ')}`);
  const time = q.time ?? q.props.find(p => p.queryTime)?.queryTime;
  if (time?.at) lines.push(`  at ${time.at}`);
  if (time?.during) lines.push(`  during ${time.during}`);
  return lines.join('\n');
};

/** `?x != "Ana"` → `except ?x "Ana"`; any other filter would be operator syntax, which a model target never uses. */
function exceptLine(filter) {
  const m = /^(\?[a-z]\w*) != ("(?:\\.|[^"\\])*")$/.exec(filter.trim());
  if (!m) throw Error(`filter ${filter} has no words form`);
  return `except ${m[1]} ${m[2]}`;
}
/** Constraint expressions in words: comparators and integer arithmetic (Q-LANG-7). */
const WORDS = { '>=': 'at_least', '<=': 'at_most', '==': 'equal', '!=': 'not_equal', '>': 'above', '<': 'below', '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided_by' };
export const expressionWords = expression => String(expression).trim().split(/\s+/).map(token => WORDS[token] ?? token).join(' ');

const PRINTERS = new Map();
/** Register a printer: `print(row) → {target: string|null, format, provisional: [..], lossy: [..]}`; `row`
 * carries `surface` (surface IR) and `canon` (canonical IR). */
export function registerPrinter(name, print) { PRINTERS.set(name, print); }
export const printerNames = () => [...PRINTERS.keys()];
export function printTarget(name, row) {
  const printer = PRINTERS.get(name);
  if (!printer) throw Error(`Unknown printer ${name}; registered: ${printerNames().join(', ')}`);
  return printer(row);
}

registerPrinter('strings', ({ surface }) => {
  const ir = validateSurface(surface);
  if (ir.unclear) return { target: `@u unclear\n  kind ${ir.unclear.kind}\n${(ir.unclear.readings ?? []).map(r => `  reading ${r}\n`).join('')}`, format: 'strings', provisional: [] };
  const wires = [], provisional = new Set();
  ir.stated.forEach((p, i) => wires.push([`@s${i + 1} stated`, ...propositionLines(p), `  certainty ${p.certainty}`, ...(p.speaker ? [`  speaker ${p.speaker}`] : [])].join('\n')));
  ir.assumed.forEach((p, i) => wires.push([`@a${i + 1} assumed`, ...propositionLines(p), ...(p.basis ? [`  basis ${p.basis}`] : [])].join('\n')));
  if (ir.query) wires.push(queryWire(ir.query, 'q'));
  (ir.moreQueries ?? []).forEach((q, n) => wires.push(queryWire(q, `q${n + 2}`)));
  if (ir.constraint) {
    const c = ir.constraint;
    wires.push([`@c constraint`, ...c.vars.map(([name, lo, hi]) => `  var ${name} int ${lo} ${hi}`), ...c.require.map(e => `  require ${expressionWords(e)}`), `  claim ${expressionWords(c.claim)}`, `  task ${c.task}`, ...(c.select?.length ? [`  select ${c.select.join(' ')}`] : [])].join('\n'));
  }
  return { target: wires.join('\n\n') + '\n', format: 'strings', provisional: [...provisional] };
});
