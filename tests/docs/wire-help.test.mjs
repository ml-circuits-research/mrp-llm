// Executes the wire help pages under docs/wire_typs/ against the real parser,
// lowering, declarative compiler, runtime and lexicon, and checks that the
// field tables and the wire index agree with the parser SPEC.
//
// Markup contract (see docs/wire_typs/*.html):
//   <pre data-sop="current">   a valid program; it must parse, pass
//                              validateGraph, lower its ground declarations,
//                              compile when it is model-authored only, and run
//                              without throwing: under the model-origin compiler
//                              when it uses stated/assumed/unclear/unparsed, otherwise
//                              under a trusted Runtime. A program of model
//                              wire types only, without an atom-condition
//                              query, also passes the model-origin compiler.
//   data-value="wire=JSON"     (on a current example) the run gives that wire
//                              exactly this value, e.g. data-value="answer=240".
//   <pre data-sop="invalid" data-check="STAGE" data-error="TEXT">
//                              every stage before STAGE succeeds and STAGE
//                              fails with an error containing TEXT. STAGE is
//                              parse | graph | lower | compile | runtime.
//                              The compile stage always applies the model-origin
//                              compiler, so it shows what a model may not author.
//   data-status="wire=status"  (runtime stage only, instead of data-error) the
//                              run completes but reports that status, such as
//                              an explicit unsupported route.
//
// Knowledge-language examples (DS004 "Knowledge wires", validated by sop/knowledge/, never by the host
// runtime) use three further kinds:
//   <pre data-sop="knowledge" [data-warnings="code,code"]>
//                              knowledge circuits: validateProgram reports no error and exactly the
//                              declared warnings.
//   <pre data-sop="knowledge-query" [data-run="validate"] [data-status=".."] [data-rows="a=1,b=2;a=3,b=4"]
//                              [data-count="N"] [data-conditional="id,id"] [data-effects="id:class,id:class"]
//                              [data-explanations="id+id;id"] [data-necessary="id,id"]>
//                              a query circuit (or a constraint) validated together with the preceding
//                              knowledge example of the page and executed by the js-reference oracle,
//                              which must give the declared status, rows, count and conditional list,
//                              the effect class of each candidate (mode effect) and the explaining sets
//                              and necessary candidates (mode abduce over candidates, Q-LANG-10).
//                              data-run="validate" marks a question the oracle declares not_expressible
//                              (a mode of work): it is validated only, and the oracle must say so.
//   <pre data-sop="knowledge-invalid" data-error="code" [data-role="query"]>
//                              the validator must report the problem code (error or warning).
//   data-run="sandbox" data-status=".."   (on a knowledge example with code and test wires) the code-sandbox strategy must give the declared status
//   data-run="vrc" data-status=".."   a numeric-action plan query (extension E2): the
//                              vrc-compressed-planning strategy must give the declared status.
// A page documents the keywords of a knowledge wire in a table whose first column holds the grammar fields:
// the first table of a page of a knowledge-only wire, or the table marked data-knowledge="fields" of a page
// whose name the host circuits share. Their anchors are field-KEY and kfield-KEY.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse, validateGraph, dependencies, SPEC} from '../../sop/parser.mjs';
import {lowerFact, lowerRule, lowerQuery, lowerConstraint} from '../../sop/lower.mjs';
import {compileDeclarative, MODEL_TYPES} from '../../sop/declarative.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {demoLexicon} from '../../lib/knowledge-seeds.mjs';
import {Repository} from '../../memory/repository.mjs';
import {helpPages, pageExamples, tableFields, attr, decode} from '../../tools/wire-help-pages.mjs';
import {GRAMMAR, validateProgram} from '../../sop/knowledge/index.mjs';
import {vrcCompressedPlanning} from '../../reasoning/strategies/vrc-compressed-planning/index.mjs';
import {ask, NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';
import {codeSandbox} from '../../reasoning/strategies/code-sandbox/index.mjs';

const HELP = new URL('../../docs/wire_typs/', import.meta.url);
const INDEX = new URL('../../docs/wire_types.html', import.meta.url);
const WIRES = JSON.parse(fs.readFileSync(new URL('../../sop/contracts/wires.json', import.meta.url), 'utf8')).wires;
const MODEL_ONLY = new Set(['stated', 'assumed', 'unclear', 'unparsed']);
const LEXICON = demoLexicon();
const TOPIC_PAGES = new Set(['overview', 'syntax', 'small-model', 'model-guide', 'question-types', 'knowledge-guide', 'knowledge-semantics', 'query-modes', 'governance']);
// Wire types that only the knowledge language has (no host-circuit page); the others share a page with a host form.
const KNOWLEDGE_ONLY = Object.keys(GRAMMAR).filter(type => !SPEC[type]);
const KNOWLEDGE_DOCUMENTED = Object.keys(GRAMMAR).filter(type => type !== 'stated' && type !== 'pack');
const STAGES = ['parse', 'graph', 'lower', 'compile', 'runtime'];
const NOW = Date.parse('2026-09-26T12:00:00Z');
const LOWER = {fact: lowerFact, rule: lowerRule, query: (w, v) => lowerQuery(w, v, null, {now: NOW}), constraint: lowerConstraint};

// Page, example and table extraction is shared with the vocabulary check (tools/datasets/audit/vocabulary.mjs).
const pages = helpPages(HELP);
const examples = pageExamples;

async function withRuntime(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-help-'));
  try {
    const repo = new Repository(root);
    repo.init('base');
    const session = repo.session('base', 'reviewer', 'help');
    return await fn(new Runtime({repo, session, lexicon: LEXICON, now: NOW}));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

/** Runs the stages in order; returns {stage, error} for the first failure or {values} on success. */
async function execute(source, {model = false} = {}) {
  let stage = 'parse';
  try {
    const program = parse(source);
    stage = 'graph';
    validateGraph(program);
    stage = 'lower';
    // A model query states conditions as match blocks of strings; only the host compiler lowers it.
    const modelQuery = w => w.type === 'query' && (w.fields.where ?? []).some(text => /(^|\n)match(\n|$)/.test(text));
    for (const w of program.wires) if (LOWER[w.type] && !modelQuery(w) && !dependencies(w).values.length) LOWER[w.type](w, {});
    stage = 'compile';
    // Atom-condition queries belong to trusted circuits; a model-type-only program also passes the model compiler.
    const atomQuery = w => w.type === 'query' && !modelQuery(w);
    if (model || (program.wires.every(w => MODEL_TYPES.has(w.type)) && !program.wires.some(atomQuery))) compileDeclarative(source, {lexicon: LEXICON});
    stage = 'runtime';
    const modelOnly = program.wires.some(w => MODEL_ONLY.has(w.type) || modelQuery(w));
    // Host-emitted advisory wires (pragmatic, DS023) join a model program after its compilation: the model-origin run
    // executes the model part, and the whole program has already passed parse and the graph check above.
    const modelPart = source.split(/\n\s*\n/).filter(block => !/^@\w+ pragmatic\b/.test(block.trim())).join('\n\n');
    const result = await withRuntime(runtime => modelOnly ? runtime.run(modelPart, {origin: 'model'}) : runtime.run(source));
    return {values: result.values};
  } catch (error) {
    return {stage, error};
  }
}

test('help pages and the wire index agree', () => {
  const index = fs.readFileSync(INDEX, 'utf8');
  const linked = [...index.matchAll(/<a id="([^"]+)" href="wire_typs\/([^"]+)\.html" target="wire-content" data-topic="([^"]+)"/g)];
  assert.ok(linked.length > 0, 'sidebar entries found');
  const names = new Set(pages.map(p => p.name));
  for (const [, id, file, topic] of linked) {
    assert.equal(id, file, `sidebar id matches ${file}.html`);
    assert.equal(topic, file, `sidebar topic matches ${file}.html`);
    assert.ok(names.has(file), `sidebar entry ${file} has a page`);
  }
  const sidebar = linked.map(m => m[2]);
  assert.equal(new Set(sidebar).size, sidebar.length, 'no duplicate sidebar entries');
  for (const name of names) assert.ok(sidebar.includes(name), `page ${name}.html is in the sidebar`);
  for (const type of [...Object.keys(SPEC), ...Object.keys(GRAMMAR)]) assert.ok(names.has(type), `wire ${type} has a help page`);
});

test('parser SPEC and the wire contract list the same fields', () => {
  assert.deepEqual(Object.keys(WIRES).sort(), Object.keys(SPEC).sort());
  for (const [type, spec] of Object.entries(SPEC))
    for (const key of ['one', 'many', 'required'])
      assert.deepEqual(WIRES[type][key] ?? [], spec[key] ?? [], `${type}.${key}`);
});

/** First-column keywords of the knowledge field table of a page: the table marked data-knowledge="fields", else the first table. */
function knowledgeFields(page) {
  const marked = page.html.match(/<table data-knowledge="fields">([\s\S]*?)<\/table>/)?.[1];
  return tableFields(marked ?? page.html);
}

test('every documented field exists and every field is documented', () => {
  for (const page of pages) {
    const expected = SPEC[page.name] ? [...(SPEC[page.name].one ?? []), ...(SPEC[page.name].many ?? [])] : null;
    if (!expected) continue;
    const rows = tableFields(page.html);
    assert.deepEqual([...rows].sort(), [...expected].sort(), `${page.name}.html field rows match the parser`);
  }
});

test('every knowledge wire page documents exactly the fields of the knowledge grammar', () => {
  for (const type of KNOWLEDGE_DOCUMENTED) {
    const page = pages.find(p => p.name === type);
    assert.ok(page, `${type}.html exists`);
    const expected = Object.keys(GRAMMAR[type].fields);
    assert.deepEqual(knowledgeFields(page).sort(), [...expected].sort(), `${type}.html knowledge field rows match sop/knowledge/grammar.mjs`);
    const prefix = KNOWLEDGE_ONLY.includes(type) ? 'field-' : 'kfield-';
    for (const field of expected) {
      const anchors = page.html.match(new RegExp(`\\bid="${prefix}${field}"`, 'g')) ?? [];
      assert.equal(anchors.length, 1, `${type}.html has exactly one id="${prefix}${field}"`);
    }
    if (!KNOWLEDGE_ONLY.includes(type)) assert.ok(page.html.includes('id="knowledge-language"'), `${type}.html has the Knowledge language section`);
  }
});

test('every keyword of every wire page has a stable field-<keyword> anchor', () => {
  for (const type of Object.keys(SPEC)) {
    const page = pages.find(p => p.name === type);
    assert.ok(page, `wire ${type} has a help page`);
    const fields = [...(SPEC[type].one ?? []), ...(SPEC[type].many ?? [])];
    for (const field of fields) {
      const anchors = page.html.match(new RegExp(`\\bid="field-${field}"`, 'g')) ?? [];
      assert.equal(anchors.length, 1, `${type}.html has exactly one id="field-${field}"`);
    }
  }
  for (const type of MODEL_ONLY) assert.ok(pages.some(p => p.name === type), `${type}.html exists`);
});

test('every wire page has a valid and an invalid example', () => {
  for (const page of pages) {
    if (TOPIC_PAGES.has(page.name)) continue;
    const kinds = examples(page).map(e => e.kind);
    assert.ok(kinds.some(k => k === 'current' || k === 'knowledge'), `${page.name}.html has a valid example`);
    assert.ok(kinds.includes('invalid') || kinds.includes('knowledge-invalid'), `${page.name}.html has an invalid example`);
    if (KNOWLEDGE_DOCUMENTED.includes(page.name)) {
      assert.ok(kinds.includes('knowledge-invalid'), `${page.name}.html has an invalid knowledge example`);
      assert.ok(kinds.some(k => k === 'knowledge' || k === 'knowledge-query'), `${page.name}.html has a valid knowledge example`);
    }
  }
});

test('valid help examples execute', async () => {
  for (const page of pages) for (const example of examples(page)) {
    if (example.kind !== 'current') continue;
    const result = await execute(example.source);
    assert.ok(!result.error, `${example.label} fails at ${result.stage}: ${result.error?.message}`);
    if (example.value) {
      const at = example.value.indexOf('=');
      assert.deepEqual(result.values[example.value.slice(0, at)], JSON.parse(example.value.slice(at + 1)), `${example.label} gives ${example.value}`);
    }
  }
});

test('invalid help examples fail at the documented stage with the documented reason', async () => {
  for (const page of pages) for (const example of examples(page)) {
    if (example.kind !== 'invalid') continue;
    assert.ok(STAGES.includes(example.check), `${example.label} declares a data-check stage`);
    assert.ok(example.error || example.status, `${example.label} declares data-error or data-status`);
    const result = await execute(example.source, {model: example.check === 'compile'});
    if (example.status) {
      assert.equal(example.check, 'runtime', `${example.label}: data-status needs the runtime stage`);
      assert.ok(!result.error, `${example.label} runs: ${result.error?.message}`);
      const [wire, status] = example.status.split('=');
      assert.equal(result.values[wire]?.status, status, `${example.label} reports ${status}`);
      continue;
    }
    assert.ok(result.error, `${example.label} must fail at ${example.check}`);
    assert.equal(result.stage, example.check, `${example.label} fails at ${result.stage}: ${result.error.message}`);
    assert.ok(result.error.message.includes(example.error), `${example.label}: "${result.error.message}" includes "${example.error}"`);
  }
});

/** Knowledge-language examples of a page, in order, with every data-* attribute. */
function knowledgeExamples(page) {
  return [...page.html.matchAll(/<pre data-sop="(knowledge(?:-query|-invalid)?)"([^>]*)><code>([\s\S]*?)<\/code><\/pre>/g)].map((m, index) => {
    const attrs = Object.fromEntries([...m[2].matchAll(/(data-[a-z-]+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])]));
    return {label: `${page.name}.html knowledge example ${index + 1}`, kind: m[1], source: decode(m[3]), attrs};
  });
}
const rowText = row => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
const errorsOf = problems => problems.filter(p => p.severity !== 'warning');

test('knowledge examples validate with sop/knowledge and execute on the js-reference oracle', async () => {
  let checked = 0;
  for (const page of pages) {
    let knowledge = '';
    for (const example of knowledgeExamples(page)) {
      checked++;
      const {kind, source, attrs, label} = example;
      if (kind === 'knowledge') {
        const r = validateProgram([{name: label, text: source, role: 'knowledge'}]);
        assert.deepEqual(errorsOf(r.problems).map(p => `${p.code} ${p.message}`), [], `${label} validates`);
        const warnings = r.problems.filter(p => p.severity === 'warning').map(p => p.code).sort().join(',');
        assert.equal(warnings, (attrs['data-warnings'] ?? '').split(',').filter(Boolean).sort().join(','), `${label} declares exactly its warnings`);
        knowledge = source;
        // the lexicon wires (predicate, lexeme, entity) also compile into a lexicon of a base memory
        if (/^@\S+ (predicate|lexeme|entity)$/m.test(source)) assert.doesNotThrow(() => Lexicon.fromCircuits([{name: label, text: source}]), `${label} compiles into a lexicon`);
        // programming wires (code, test): `data-run="sandbox"` runs the example in the code-sandbox strategy, which must give the declared status
        if (attrs['data-run'] === 'sandbox') assert.equal((await codeSandbox.ask({code: source, tests: source}, {wallMs: 8000})).status, attrs['data-status'], `${label} status on code-sandbox`);
      } else if (kind === 'knowledge-query') {
        const files = [...(knowledge ? [{name: 'knowledge', text: knowledge, role: 'knowledge'}] : []), {name: label, text: source, role: 'query'}];
        const r = validateProgram(files);
        assert.deepEqual(errorsOf(r.problems).map(p => `${p.code} ${p.message}`), [], `${label} validates with the knowledge before it`);
        if (attrs['data-run'] === 'validate') {
          assert.throws(() => ask({theory: {knowledge}, query: source}, {}), error => error instanceof NotExpressibleError, `${label}: the oracle declares this question not_expressible`);
          continue;
        }
        if (attrs['data-run'] === 'vrc') {
          // numeric action (extension E2): executed by the compressed planner
          const answer = vrcCompressedPlanning.ask({handle: vrcCompressedPlanning.prepare(knowledge, {learning: 'off', query: source}), query: source}, {}, {learning: 'off'});
          assert.equal(answer.status, attrs['data-status'], `${label} status on vrc-compressed-planning`);
          continue;
        }
        const got = ask({theory: {knowledge}, query: source}, {});
        assert.equal(got.status, attrs['data-status'], `${label} status`);
        if (attrs['data-rows'] !== undefined) assert.equal((got.rows ?? []).map(rowText).sort().join(';'), attrs['data-rows'], `${label} rows`);
        if (attrs['data-count'] !== undefined) assert.equal(String(got.count), attrs['data-count'], `${label} count`);
        if (attrs['data-conditional'] !== undefined) assert.equal((got.conditional ?? []).join(','), attrs['data-conditional'], `${label} conditional`);
        if (attrs['data-effects'] !== undefined) assert.equal((got.effects ?? []).map(e => `${e.candidate}:${e.effect}`).join(','), attrs['data-effects'], `${label} effects`);
        if (attrs['data-explanations'] !== undefined) assert.equal((got.explanations ?? []).map(e => e.hypotheses.join('+')).join(';'), attrs['data-explanations'], `${label} explanations`);
        if (attrs['data-necessary'] !== undefined) assert.equal((got.necessary ?? []).join(','), attrs['data-necessary'], `${label} necessary`);
      } else {
        assert.ok(attrs['data-error'], `${label} declares data-error`);
        const r = validateProgram([{name: label, text: source, role: attrs['data-role'] ?? 'knowledge'}]);
        assert.ok(r.problems.some(p => p.code === attrs['data-error']), `${label} must report ${attrs['data-error']}; got ${r.problems.map(p => p.code).join(', ') || 'nothing'}`);
      }
    }
  }
  assert.ok(checked > 40, `knowledge examples found (${checked})`);
});

test('the pages of the knowledge language are linked from the wire index and use only their own anchors', () => {
  const index = fs.readFileSync(INDEX, 'utf8');
  for (const name of [...TOPIC_PAGES].filter(n => ['knowledge-guide', 'knowledge-semantics', 'query-modes', 'governance'].includes(n)).concat(KNOWLEDGE_ONLY)) assert.ok(index.includes(`id="${name}"`), `${name} is in the Knowledge language section of the index`);
  for (const page of pages) for (const [, href] of page.html.matchAll(/<a href="([a-zA-Z0-9_-]+)\.html(?:#[^"]*)?"/g)) assert.ok(pages.some(p => p.name === href), `${page.name}.html links to the existing page ${href}.html`);
});
