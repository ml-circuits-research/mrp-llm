// VENDORED: copied verbatim from soplab-v0.4.0.zip src/parser.mjs
import { atom, not, rule, builtin, provider, transition, assumption } from './model.mjs';
import { all, any, none, ref, condition, reduction } from './conditions.mjs';

export function tokenize(text) {
  const out = [];
  let cur = '', quote = null, escaped = false;
  const push = () => { if (cur.length) { out.push(cur); cur = ''; } };
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
  }
  if (quote) throw new Error(`Unclosed quote in: ${text}`);
  push();
  return out;
}

function splitLegacyArgs(text) {
  const out = [];
  let cur = '', quote = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseTerm(raw) {
  const t = raw.trim();
  if (t.startsWith('?')) return t;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    if (t.startsWith("'")) return t.slice(1, -1).replace(/\\'/g, "'");
    return JSON.parse(t);
  }
  return t;
}

export function parseAtom(text) {
  let s = text.trim();
  let sign = 1;
  if (/^NOT\s+/i.test(s)) { sign = -1; s = s.replace(/^NOT\s+/i, ''); }
  const legacy = s.match(/^([A-Za-z_][\w.-]*)\s*\((.*)\)$/s);
  if (legacy) {
    const args = legacy[2].trim() ? splitLegacyArgs(legacy[2]).map(parseTerm) : [];
    return sign === 1 ? atom(legacy[1], ...args) : not(legacy[1], ...args);
  }
  const parts = tokenize(s);
  if (!parts.length || !/^[A-Za-z_][\w.-]*$/.test(parts[0])) throw new Error(`Invalid relation syntax: ${text}`);
  const [pred, ...rawArgs] = parts;
  const args = rawArgs.map(parseTerm);
  return sign === 1 ? atom(pred, ...args) : not(pred, ...args);
}

export function parseConditionItem(text) {
  const s = text.trim();
  if (s.startsWith('$')) {
    const [name, ...args] = tokenize(s);
    return ref(name.slice(1), ...args.map(parseTerm));
  }
  return parseAtom(s);
}

export function parseProvider(text) {
  const [name, ...args] = tokenize(text);
  if (!name) throw new Error('CALL requires a provider name');
  return provider(name, ...args.map(parseTerm));
}

const INFIX = new Map([
  ['=', 'eq'], ['==', 'eq'], ['!=', 'neq'], ['<', 'lt'], ['<=', 'lte'], ['>', 'gt'], ['>=', 'gte'],
]);

export function parseTest(text) {
  const parts = tokenize(text);
  if (parts.length === 3 && INFIX.has(parts[1])) return builtin(INFIX.get(parts[1]), parseTerm(parts[0]), parseTerm(parts[2]));
  if (!parts.length) throw new Error('TEST requires an expression');
  return builtin(parts[0], ...parts.slice(1).map(parseTerm));
}

function lineToExpr(line) {
  if (['WHEN', 'WHERE', 'IF', 'AND', 'OR', 'MATCH', 'USE', 'FROM'].includes(line.key)) return parseConditionItem(line.value);
  if (line.key === 'TEST') return parseTest(line.value);
  if (line.key === 'NONE') return none(parseConditionItem(line.value));
  if (line.key === 'CALL') return parseProvider(line.value);
  throw new Error(`Cannot parse condition keyword ${line.key}`);
}

function parseLogicLines(lines, acceptedStart = new Set(['WHEN', 'WHERE', 'IF'])) {
  const branches = [[]];
  let started = false;
  for (const line of lines) {
    if (acceptedStart.has(line.key)) {
      if (started && line.key === 'WHEN') throw new Error('WHEN may only start a condition');
      branches.at(-1).push(lineToExpr(line));
      started = true;
    } else if (line.key === 'AND' || line.key === 'TEST' || line.key === 'NONE' || line.key === 'CALL') {
      branches.at(-1).push(lineToExpr(line));
      started = true;
    } else if (line.key === 'OR') {
      branches.push([lineToExpr(line)]);
      started = true;
    }
  }
  if (!started) return all();
  const xs = branches.map((b) => b.length === 1 ? b[0] : all(...b));
  return xs.length === 1 ? xs[0] : any(...xs);
}

function parseAggregate(line, id) {
  const parts = tokenize(line.value);
  const asIndex = parts.findIndex((x) => x.toUpperCase() === 'AS');
  if (asIndex < 0 || asIndex === parts.length - 1) throw new Error(`${line.key} in @${id} requires AS ?output`);
  const before = parts.slice(0, asIndex).map(parseTerm);
  const as = parseTerm(parts[asIndex + 1]);
  if (typeof as !== 'string' || !as.startsWith('?')) throw new Error(`${line.key} output in @${id} must be a ?variable`);
  const op = line.key.toLowerCase();
  const field = before.length ? before[0] : null;
  if (op !== 'count' && field == null) throw new Error(`${line.key} in @${id} requires an input field`);
  return { op, field, as };
}

function parseBlocks(text) {
  const blocks = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@')) {
      const m = line.match(/^@([^\s]+)\s+([^\s]+)$/);
      if (!m) throw new Error(`Invalid block header: ${line}`);
      if (current) blocks.push(current);
      current = { id: m[1], type: m[2].toLowerCase(), lines: [] };
    } else {
      if (!current) throw new Error(`Line outside block: ${line}`);
      const sp = line.indexOf(' ');
      current.lines.push({ key: (sp < 0 ? line : line.slice(0, sp)).toUpperCase(), value: sp < 0 ? '' : line.slice(sp + 1).trim() });
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

export function parseSOP(text) {
  const blocks = parseBlocks(text);
  const result = { facts: [], wires: [], rules: [], goals: [], transitions: [], assumptions: [], raw: blocks };

  for (const b of blocks) {
    if (b.type === 'claim') {
      const value = b.lines.find((x) => x.key === 'VALUE')?.value;
      if (!value) throw new Error(`claim @${b.id} requires VALUE`);
      result.facts.push({
        id: b.id, atom: parseAtom(value),
        meta: Object.fromEntries(b.lines.filter((x) => x.key !== 'VALUE').map((x) => [x.key.toLowerCase(), x.value])),
      });
      continue;
    }

    if (b.type === 'all' || b.type === 'any') {
      const params = b.lines.filter((x) => x.key === 'GIVES').flatMap((x) => tokenize(x.value).map(parseTerm));
      if (params.some((x) => typeof x !== 'string' || !x.startsWith('?'))) throw new Error(`GIVES in @${b.id} may contain only ?variables`);
      const logic = b.lines.filter((x) => x.key !== 'GIVES');
      if (b.type === 'all' && logic.some((x) => x.key === 'OR')) throw new Error(`OR inside @${b.id} all is ambiguous; compose an @... any wire instead`);
      if (b.type === 'any' && logic.some((x) => x.key === 'AND')) throw new Error(`AND inside @${b.id} any is ambiguous; compose an @... all wire for that branch`);
      const items = logic.map(lineToExpr);
      result.wires.push(condition(b.id, b.type, params, items));
      continue;
    }

    if (b.type === 'reduce') {
      const params = b.lines.filter((x) => x.key === 'GIVES').flatMap((x) => tokenize(x.value).map(parseTerm));
      const from = b.lines.find((x) => x.key === 'FROM');
      if (!from) throw new Error(`reduce @${b.id} requires FROM`);
      const groupBy = b.lines.filter((x) => x.key === 'GROUP').flatMap((x) => tokenize(x.value).map(parseTerm));
      const aggs = b.lines.filter((x) => ['COUNT', 'SUM', 'MIN', 'MAX', 'COLLECT', 'SET', 'FIRST'].includes(x.key)).map((x) => parseAggregate(x, b.id));
      if (!aggs.length) throw new Error(`reduce @${b.id} requires at least one aggregate`);
      result.wires.push(reduction(b.id, { params, source: parseConditionItem(from.value), groupBy, aggregates: aggs }));
      continue;
    }

    if (b.type === 'rule') {
      const then = b.lines.find((x) => x.key === 'THEN')?.value;
      if (!then) throw new Error(`rule @${b.id} requires THEN`);
      const logic = b.lines.filter((x) => ['WHEN', 'IF', 'AND', 'OR', 'TEST', 'NONE', 'CALL'].includes(x.key));
      result.rules.push(rule(b.id, parseAtom(then), parseLogicLines(logic, new Set(['WHEN', 'IF']))));
      continue;
    }

    if (b.type === 'goal') {
      const logic = b.lines.filter((x) => ['WHERE', 'AND', 'OR', 'TEST', 'NONE', 'CALL'].includes(x.key));
      const find = b.lines.filter((x) => x.key === 'FIND').flatMap((x) => tokenize(x.value).map(parseTerm));
      result.goals.push({ id: b.id, where: parseLogicLines(logic, new Set(['WHERE'])), find });
      continue;
    }

    if (b.type === 'transition') {
      const logic = b.lines.filter((x) => ['WHEN', 'IF', 'AND', 'OR', 'TEST', 'NONE', 'CALL'].includes(x.key));
      const add = b.lines.filter((x) => x.key === 'ADD').map((x) => parseAtom(x.value));
      const remove = b.lines.filter((x) => x.key === 'REMOVE').map((x) => parseAtom(x.value));
      const rawCost = b.lines.find((x) => x.key === 'COST')?.value ?? '1';
      const cost = Number(rawCost);
      if (!Number.isFinite(cost) || cost < 0) throw new Error(`Invalid COST in @${b.id}`);
      result.transitions.push(transition(b.id, { when: parseLogicLines(logic, new Set(['WHEN', 'IF'])), add, remove, cost }));
      continue;
    }

    if (b.type === 'assumption') {
      const value = b.lines.find((x) => x.key === 'VALUE')?.value;
      if (!value) throw new Error(`assumption @${b.id} requires VALUE`);
      const cost = Number(b.lines.find((x) => x.key === 'COST')?.value ?? '1');
      result.assumptions.push(assumption(b.id, parseAtom(value), { cost }));
      continue;
    }

    throw new Error(`Unknown block type @${b.id} ${b.type}`);
  }
  return result;
}

export function loadSOP(reasoner, parsed) {
  for (const f of parsed.facts) reasoner.fact(f.atom, { kind: 'source', source: f.id, meta: f.meta });
  reasoner.addWires(parsed.wires ?? []);
  reasoner.addRules(parsed.rules ?? []);
  return reasoner;
}
