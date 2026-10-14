#!/usr/bin/env node
/**
 * The capability coverage matrix: for every capability and combination cell of the inventory (eval/capabilities/capabilities.json),
 * how many circuits of each source EXERCISE it, detected by parsing those circuits with the product parsers (tools/capabilities/tags.mjs),
 * never by grepping names.
 *
 * Sources:
 *   tests        the circuits the unit tests actually parse: `--capture` runs every `tests/<component>/*.test.mjs` (`node --test`) with
 *                CHATSOP_CIRCUIT_CAPTURE (lib/circuit-capture.mjs) and keeps the capture; otherwise the last capture is read
 *   smoke        eval/smoke-reasoning/cases/<id>/{knowledge,query}.sop (executed on every engine) and invalid/*.sop (must be rejected)
 *   wire-help    the executable examples of docs/wire_typs/*.html (tests/docs/wire-help.test.mjs)
 *   regression   the circuits of the formalization regression runs (state/formalization-regression/<run>/results.jsonl, local only)
 *   battery      the capability battery itself (L1 cases, L2 programs, L3 circuits), with `--battery`
 *
 * A negative circuit (an invalid fixture, an L1 negative) covers the validator codes it triggers (`k.check.*`, `m.check.*`).
 * Status per cell: uncovered (no circuit), thin (1 or 2 circuits), covered (3 or more).
 *
 *   node tools/capabilities/coverage.mjs [--capture] [--capture-dir DIR] [--battery] [--label before|after] [--out DIR]
 * writes <out>/coverage-<label>.json and coverage-<label>.md (default out eval/reports/current/capabilities).
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {circuitTags, knowledgeTags} from './tags.mjs';
import {checkTags} from './checks.mjs';
import {loadInventory, ROOT} from './inventory.mjs';
import {helpPages, pageExamples} from '../wire-help-pages.mjs';

export const REPORTS = path.join(ROOT, 'eval/reports/current/capabilities');
const SOURCES = ['tests', 'smoke', 'wire-help', 'regression', 'battery'];
const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

/** Is this knowledge text only the query side (a query, a constraint, a policy, supposed facts)? */
const QUERY_SIDE = /^@\S+\s+(query|constraint|policy)\s*$/m;
const onlyQuerySide = text => {
  const heads = [...text.matchAll(/^@\S+\s+(\S+)\s*$/gm)].map(m => m[1]);
  return heads.length > 0 && heads.every(t => ['query', 'constraint', 'policy', 'fact'].includes(t)) && QUERY_SIDE.test(text);
};

/** Circuits the tests parsed, from a capture directory: a knowledge-side query is paired with the last knowledge text its process parsed. */
export function capturedCircuits(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.jsonl'))) {
    const texts = new Map();
    let lastKnowledge = '';
    for (const r of readJsonl(path.join(dir, f))) {
      if (r.text) texts.set(r.h ?? hash(r.text), r.text);
      const text = r.text ?? texts.get(r.h);
      if (!text) continue;
      const file = r.file ?? 'unknown';
      if (/tests\/(?:[^/]+\/)?capability-/.test(file)) continue; // the battery's own test is the `battery` source
      if (r.surface === 'knowledge') {
        if (onlyQuerySide(text)) out.push({source: 'tests', ref: file, circuit: {knowledge: lastKnowledge, query: text}});
        else { lastKnowledge = text; out.push({source: 'tests', ref: file, circuit: {knowledge: text, query: ''}}); }
      } else out.push({source: 'tests', ref: file, circuit: {text}});
    }
  }
  return out;
}

export function smokeCircuits() {
  const root = path.join(ROOT, 'eval/smoke-reasoning');
  const out = [];
  for (const id of fs.readdirSync(path.join(root, 'cases')).sort()) {
    const d = path.join(root, 'cases', id);
    const read = n => fs.existsSync(path.join(d, n)) ? fs.readFileSync(path.join(d, n), 'utf8') : '';
    out.push({source: 'smoke', ref: 'smoke/' + id, circuit: {knowledge: read('knowledge.sop'), query: read('query.sop')}});
  }
  for (const f of fs.readdirSync(path.join(root, 'invalid')).sort()) out.push({source: 'smoke', ref: 'smoke/invalid/' + f, negative: true, circuit: {text: fs.readFileSync(path.join(root, 'invalid', f), 'utf8'), role: 'any'}});
  return out;
}

export function wireHelpCircuits() {
  const out = [];
  for (const page of helpPages(new URL('../../docs/wire_typs/', import.meta.url))) {
    let knowledge = '';
    for (const ex of pageExamples(page)) {
      const ref = 'wire-help/' + page.name + ':' + ex.line;
      if (ex.kind === 'knowledge') { knowledge = ex.source; out.push({source: 'wire-help', ref, circuit: {knowledge: ex.source, query: ''}}); }
      else if (ex.kind === 'knowledge-query') out.push({source: 'wire-help', ref, circuit: {knowledge, query: ex.source}});
      else if (ex.kind === 'knowledge-invalid') out.push({source: 'wire-help', ref, negative: true, circuit: {text: ex.source, role: ex.role ?? 'any'}});
      else if (ex.kind === 'invalid') out.push({source: 'wire-help', ref, negative: true, circuit: {text: ex.source, surface: 'model'}});
      else if (ex.kind === 'current') out.push({source: 'wire-help', ref, circuit: {text: ex.source}});
    }
  }
  return out;
}

/** Circuits the formalization regression runs produced (local state only; the texts never enter git). */
export function regressionCircuits() {
  const dir = path.join(ROOT, 'state/formalization-regression');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const seen = new Set();
  for (const run of fs.readdirSync(dir).sort()) {
    for (const r of readJsonl(path.join(dir, run, 'results.jsonl'))) {
      if (!r.sop || seen.has(r.sop)) continue;
      seen.add(r.sop);
      out.push({source: 'regression', ref: 'regression/' + r.id, circuit: {text: r.sop}});
    }
  }
  return out;
}

/** The tags of one collected circuit: the parse tags, the validator codes it triggers, and the tags its source names (`tags`: the FOL converter capabilities of a converter case). */
export function tagsOf(item) {
  const tags = new Set(item.tags ?? []);
  const c = item.circuit;
  try { for (const t of circuitTags(c)) tags.add(t); } catch { /* an unreadable circuit covers what checkTags finds */ }
  for (const t of checkTags(c)) tags.add(t);
  return tags;
}

/** Program-level combination cells covered by a tag set. */
export function combinationsOf(tags, inventory) {
  const out = [];
  for (const cell of inventory.combinations) if (cell.tags.every(t => tags.has(t))) out.push(cell.id);
  return out;
}

export function buildMatrix(items, inventory = loadInventory()) {
  const cells = new Map([...inventory.capabilities.map(c => [c.id, c]), ...inventory.combinations.map(c => [c.id, c])].map(([id, c]) => [id, {id, layers: c.layers, invalid: c.invalid, bySource: Object.fromEntries(SOURCES.map(s => [s, 0])), circuits: new Set(), refs: new Set()}]));
  const unknownTags = new Map();
  for (const item of items) {
    const tags = tagsOf(item);
    const key = item.source + ':' + hash(JSON.stringify(item.circuit));
    for (const id of [...tags, ...combinationsOf(tags, inventory)]) {
      const cell = cells.get(id);
      if (!cell) { if (!id.startsWith('x.') || id.split('.').length > 3) unknownTags.set(id, (unknownTags.get(id) ?? 0) + 1); continue; }
      if (cell.circuits.has(key)) continue;
      cell.circuits.add(key);
      cell.bySource[item.source]++;
      if (cell.refs.size < 5) cell.refs.add(item.ref);
    }
  }
  const rows = [...cells.values()].map(c => {
    const total = c.circuits.size;
    return {id: c.id, layers: c.layers, invalid: c.invalid || undefined, total, bySource: c.bySource, status: total === 0 ? 'uncovered' : total <= 2 ? 'thin' : 'covered', refs: [...c.refs]};
  });
  const summarize = list => ({cells: list.length, covered: list.filter(r => r.status === 'covered').length, thin: list.filter(r => r.status === 'thin').length, uncovered: list.filter(r => r.status === 'uncovered').length});
  const singles = rows.filter(r => !r.id.startsWith('x.')), combos = rows.filter(r => r.id.startsWith('x.'));
  return {
    summary: {all: summarize(rows), capabilities: summarize(singles), combinations: summarize(combos),
      byPrefix: Object.fromEntries([...new Set(rows.map(r => r.id.split('.').slice(0, 2).join('.')))].sort().map(p => [p, summarize(rows.filter(r => r.id.split('.').slice(0, 2).join('.') === p))])),
      circuits: Object.fromEntries(SOURCES.map(s => [s, items.filter(i => i.source === s).length]))},
    unknownTags: Object.fromEntries([...unknownTags].sort((a, b) => b[1] - a[1]).slice(0, 50)),
    rows
  };
}

export function renderMarkdown(matrix, label) {
  const s = matrix.summary;
  const line = (name, x) => `| ${name} | ${x.cells} | ${x.covered} | ${x.thin} | ${x.uncovered} |`;
  const out = [`# Capability coverage (${label})`, '', 'Generated by `node tools/capabilities/coverage.mjs`; counts are circuits that exercise a cell, read by parsing them (tools/capabilities/tags.mjs). thin = 1 or 2 circuits.', '',
    '| scope | cells | covered | thin | uncovered |', '| --- | --- | --- | --- | --- |', line('all', s.all), line('capabilities', s.capabilities), line('combinations', s.combinations), '',
    '| prefix | cells | covered | thin | uncovered |', '| --- | --- | --- | --- | --- |', ...Object.entries(s.byPrefix).map(([p, x]) => line(p, x)), '',
    'Circuits per source: ' + Object.entries(s.circuits).map(([k, v]) => `${k} ${v}`).join(', '), '', '## Uncovered', ''];
  for (const prefix of Object.keys(s.byPrefix)) {
    const list = matrix.rows.filter(r => r.status === 'uncovered' && r.id.split('.').slice(0, 2).join('.') === prefix);
    if (list.length) out.push(`- **${prefix}** (${list.length}): ` + list.map(r => '`' + r.id + '`').join(', '));
  }
  out.push('', '## Thin', '');
  for (const prefix of Object.keys(s.byPrefix)) {
    const list = matrix.rows.filter(r => r.status === 'thin' && r.id.split('.').slice(0, 2).join('.') === prefix);
    if (list.length) out.push(`- **${prefix}** (${list.length}): ` + list.map(r => '`' + r.id + '` ' + r.total).join(', '));
  }
  return out.join('\n') + '\n';
}

export function runCapture(dir) {
  fs.rmSync(dir, {recursive: true, force: true});
  // Every test file under tests/ (one folder per component), as `npm test` runs them.
  const testFiles = d => fs.readdirSync(path.join(ROOT, d), {withFileTypes: true}).flatMap(e => (e.isDirectory() ? (e.name === 'fixtures' ? [] : testFiles(`${d}/${e.name}`)) : e.name.endsWith('.test.mjs') ? [`${d}/${e.name}`] : []));
  const tests = testFiles('tests').sort();
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...tests], {cwd: ROOT, env: {...process.env, CHATSOP_CIRCUIT_CAPTURE: dir}, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  return {status: r.status};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const label = opt('--label', 'current'), out = path.resolve(opt('--out', REPORTS));
  const captureDir = path.resolve(opt('--capture-dir', path.join(REPORTS, 'capture-' + label)));
  if (args.includes('--capture')) console.error('capture: ' + JSON.stringify(runCapture(captureDir)));
  const items = [...capturedCircuits(captureDir), ...smokeCircuits(), ...wireHelpCircuits(), ...regressionCircuits()];
  if (args.includes('--battery')) {
    const {batteryCircuits} = await import('./battery-circuits.mjs');
    items.push(...await batteryCircuits());
  }
  const matrix = buildMatrix(items);
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, `coverage-${label}.json`), JSON.stringify(matrix, null, 1) + '\n');
  fs.writeFileSync(path.join(out, `coverage-${label}.md`), renderMarkdown(matrix, label));
  console.log(JSON.stringify({label, ...matrix.summary.all, capabilities: matrix.summary.capabilities, combinations: matrix.summary.combinations, circuits: matrix.summary.circuits, out: path.relative(ROOT, out)}));
}

export {knowledgeTags};
