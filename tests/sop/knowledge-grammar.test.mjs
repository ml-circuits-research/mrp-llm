// The single knowledge grammar source (`sop/knowledge/`, DS004 "Knowledge wires"): its exports, the compatibility re-exports
// of the oracle and the smoke harness, the generated grammar blocks of the documentation, the model boundary (the model-origin
// compiler rejects every knowledge wire; the reasoning modes are question forms answered not_computable without a strategy),
// the governance filter, the desugarer and the command line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as knowledge from '../../sop/knowledge/index.mjs';
import * as oracleParse from '../../reasoning/strategies/js-reference/parse.mjs';
import * as oracleWires from '../../reasoning/strategies/js-reference/wires.mjs';
import * as oracleGovernance from '../../reasoning/strategies/js-reference/governance.mjs';
import * as oracleDesugar from '../../reasoning/strategies/js-reference/desugar.mjs';
import * as smokeValidator from '../../eval/smoke-reasoning/validator.mjs';
import * as smokeGovernance from '../../eval/smoke-reasoning/lib/governance.mjs';
import * as smokeDesugar from '../../eval/smoke-reasoning/lib/desugar.mjs';
import {compileDeclarative} from '../../sop/declarative.mjs';
import {ENUMS, QUERY_MODES, REASONING_QUERY_MODES, PRODUCT_REASONING_MODES, ROLE_NAMES, LINK_WORDS, ORDER_WORDS, COMPARATOR_WORDS, ARITHMETIC_WORDS} from '../../sop/enums.mjs';

const {GRAMMAR, parse, validateProgram, selectInForce, supposedWireIds, contestedIds, desugar, desugarText, grammarCompact} = knowledge;
const read = rel => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
const errors = r => r.problems.filter(p => p.severity !== 'warning').map(p => p.code);

test('the grammar has the wire types of DS004 and shares its words with the model language', () => {
  assert.deepEqual(Object.keys(GRAMMAR), ['predicate', 'lexeme', 'entity', 'fact', 'rule', 'default', 'integrity', 'reply', 'aggregate', 'constraint', 'action', 'method', 'norm', 'procedure', 'amendment', 'argument', 'trace', 'goal', 'hypothesis', 'policy', 'stated', 'query', 'test', 'code', 'pack']);
  assert.deepEqual(knowledge.QUERY_MODES, [...QUERY_MODES, ...REASONING_QUERY_MODES]);
  assert.deepEqual(knowledge.ROLE_NAMES, [...ROLE_NAMES]);
  assert.deepEqual(knowledge.LINK_KEYWORDS, [...LINK_WORDS]);
  assert.deepEqual(knowledge.ORDER_WORDS, [...ORDER_WORDS]);
  assert.deepEqual(knowledge.COMPARATORS, Object.keys(COMPARATOR_WORDS));
  assert.deepEqual(knowledge.ARITHMETIC, Object.keys(ARITHMETIC_WORDS));
  assert.deepEqual(Object.keys(GRAMMAR.query.fields).filter(k => LINK_WORDS.includes(k)), [...LINK_WORDS]);
});

test('the oracle and the smoke harness re-export the one implementation, with no copy', () => {
  assert.equal(oracleParse.parse, knowledge.parse);
  assert.equal(oracleParse.validateProgram, knowledge.validateProgram);
  for (const name of ['parse', 'tokens', 'atomFrom', 'parseCondition', 'leaves', 'termError']) assert.equal(oracleWires[name], knowledge[name], name);
  for (const name of ['selectInForce', 'supposedWireIds', 'contestedIds', 'GOVERNED']) assert.equal(oracleGovernance[name], knowledge[name], name);
  assert.equal(oracleDesugar.desugar, knowledge.desugar);
  for (const name of ['validateProgram', 'validateWires', 'parse', 'GRAMMAR', 'grammarMarkdown', 'grammarCompact']) assert.equal(smokeValidator[name], knowledge[name], name);
  assert.equal(smokeGovernance.selectInForce, knowledge.selectInForce);
  assert.equal(smokeDesugar.desugarText, knowledge.desugarText);
  // the duplicate copies are gone: the oracle's wire parser and the smoke validator hold no implementation
  assert.ok(read('reasoning/strategies/js-reference/wires.mjs').split('\n').length < 12);
  assert.ok(read('eval/smoke-reasoning/validator.mjs').split('\n').length < 30);
});

test('the grammar blocks of DS004 and of the authoring guide are the generated ones', () => {
  const generated = grammarCompact();
  for (const rel of ['docs/specs/DS004-sop.md', 'skills/sop-wire-authoring/authoring-guide.md']) {
    const block = /<!-- grammar:begin -->\n([\s\S]*?)\n<!-- grammar:end -->/.exec(read(rel))?.[1];
    assert.equal(block?.trim(), generated.trim(), `${rel} grammar block matches \`validator.mjs --grammar-compact\``);
  }
});

test('the model-origin compiler rejects every knowledge wire', () => {
  const wires = {
    predicate: '  args subject:entity', fact: '  holds p a\n  valid timeless', rule: '  when p ?x\n  then q ?x', default: '  when p ?x\n  then q ?x\n  except r ?x',
    integrity: '  never p ?x\n  witness ?x', aggregate: '  over p ?x\n  count as ?n\n  yields c ?n', action: '  params ?x\n  requires p ?x\n  adds q ?x',
    method: '  achieves p ?x\n  step ~a ?x', norm: '  forbid ~a ?x', procedure: '  members $a', amendment: '  of $a\n  proposed_by user', argument: '  for $a\n  claim "x"',
    trace: '  step ~a b', goal: '  where p a', hypothesis: '  holds p a', policy: '  effort quick',
    test: '  of t1\n  call "f()"\n  expect "1"', code: '  of t1\n  language javascript\n  entry f\n  body "function f() {}"'
  };
  for (const [type, body] of Object.entries(wires)) assert.throws(() => compileDeclarative(`@x1 ${type}\n${body}\n`, {inputText: 'x'}), `${type} is not model-authorable`);
});

test('the reasoning modes are question forms; why_not, abduce and effect go to the oracle, the others are answered not_computable', () => {
  assert.deepEqual([...ENUMS.query.mode], [...QUERY_MODES, ...REASONING_QUERY_MODES]);
  assert.deepEqual([...PRODUCT_REASONING_MODES], ['why_not', 'abduce', 'effect']);
  for (const mode of REASONING_QUERY_MODES) {
    // mode effect checks its claim against candidates (Q-LANG-10): one supposed statement, on a runtime that runs candidates
    const candidate = mode === 'effect' ? '@s1 stated\n  certainty supposed\n  relation "power off"\n  role subject "router"\n  polarity affirmed\n' : '';
    const source = candidate + `@q query\n  mode ${mode}\n  where match\n    relation "reset"\n    role subject "router"\n    polarity affirmed\n  end\n` + (candidate ? '  candidate $s1\n' : '');
    const plan = compileDeclarative(source, {inputText: 'How do I reset the router?', hypothetical: true});
    const routed = PRODUCT_REASONING_MODES.includes(mode);
    // without a lexicon the relation does not link, so a routed mode stops at the link question; it is never reported not_computable
    assert.deepEqual(plan.notComputable.map(n => n.declaration), routed ? [] : ['q'], `${mode} is ${routed ? 'routed to the oracle' : 'understood and reported'}, never answered as a select`);
    if (!routed) assert.equal(plan.problemIds.length, 0, `${mode} schedules no engine`);
  }
  // the five older modes still compile to a problem
  const select = compileDeclarative('@q query\n  select ?x\n  where match\n    relation "work at"\n    role subject ?x\n    role object "Acme"\n    polarity affirmed\n  end\n', {inputText: 'Who works at Acme?'});
  assert.equal(select.notComputable.length, 0);
});

test('governance: approved and contested wires bind, proposed and rejected only when supposed, asof selects the version', () => {
  const text = `@a predicate
  args subject:entity
@r1 rule
  when a ?x
  then a ?x
  version 1
  approval superseded
  approved_at 2025-01-01
@r2 rule
  when a ?x
  then a ?x
  version 2
  supersedes $r1
  approval approved
  approved_at 2026-01-01
@r3 rule
  when a ?x
  then a ?x
  approval contested
@r4 rule
  when a ?x
  then a ?x
  approval proposed
@r5 rule
  when a ?x
  then a ?x
  approval rejected
`;
  const wires = parse(text).wires;
  const ids = r => r.filter(w => w.type === 'rule').map(w => w.id).sort().join(',');
  assert.equal(ids(selectInForce(wires)), 'r2,r3');
  assert.deepEqual(contestedIds(wires), ['r3']);
  assert.equal(ids(selectInForce(wires, {include: ['r4', 'r5']})), 'r2,r3,r4,r5');
  assert.equal(ids(selectInForce(wires, {asof: '2025-06-01'})), 'r1,r3');
  assert.equal(ids(selectInForce(wires, {asof: '2026-06-01'})), 'r2,r3');
  const q = parse('@q query\n  where a ?x\n  select ?x\n  if $am\n').wires;
  const am = parse(text + '@am amendment\n  of $r2\n  proposed_by user\n  members $r4\n').wires;
  assert.deepEqual(supposedWireIds(q, am), ['r4']);
});

test('desugaring: defaults and integrity become core rules, and the origin names the author\'s wire', () => {
  const text = `@bird predicate
  args subject:entity
@flies predicate
  args subject:entity
@d default
  when bird ?x
  then flies ?x
  except penguin ?x
@i integrity
  never bird ?x
  witness ?x
`;
  const {wires, origin} = desugar(parse(text).wires);
  assert.ok(wires.every(w => w.type !== 'default' && w.type !== 'integrity'));
  assert.equal(origin.get('x_d_fire'), 'd');
  assert.equal(origin.get('x_i_violation'), 'i');
  const core = desugarText(text);
  assert.match(core, /@x_d_fire rule/);
  assert.match(core, /@violation predicate/);
  // generated wires carry the reserved x_ prefix on purpose; everything else about the desugared program must be valid
  assert.deepEqual(errorsOf(validateProgram([{name: 'core', text: core, role: 'knowledge'}])).filter(code => code !== 'reserved_prefix'), []);
});
const errorsOf = problems => (problems.problems ?? problems).filter(p => p.severity !== 'warning').map(p => p.code);

test('validator: the checks that define the language', () => {
  const run = (text, role = 'knowledge', opts = {}) => validateProgram([{name: 't', text, role}], opts);
  const codes = r => r.problems.map(p => p.code);
  assert.ok(codes(run('@a predicate\n  args subject:entity\n@b predicate\n  args subject:entity\n@r rule\n  when a ?x\n  when absent b ?x\n  then a ?x\n')).includes('absent_needs_closed'));
  assert.ok(codes(run('@a predicate\n  args subject:entity\n@f fact\n  holds a x y\n')).includes('arity_mismatch'));
  assert.ok(codes(run('@a predicate\n  args a:entity b:entity c:entity d:entity e:entity f:entity g:entity\n')).includes('bad_args'));
  assert.ok(codes(run('@x_f fact\n  holds a b\n')).includes('reserved_prefix'));
  assert.ok(codes(run('@q query\n  where a ?x\n  select ?x\n')).includes('wrong_file_role'));
  // authoring mode ignores the host-written fields with a warning; memory mode requires them together
  const rule = '@a predicate\n  args subject:entity\n@r rule\n  when a ?x\n  then a ?x\n  approval approved\n';
  assert.ok(codes(run(rule)).includes('approval_incomplete'));
  const authoring = run(rule, 'knowledge', {authoring: true});
  assert.deepEqual(codes(authoring), ['governance_ignored']);
  assert.equal(authoring.ok, true);
  // zero to six terms; a seventh is rejected
  assert.deepEqual(errorsOf(run('@p predicate\n  args none\n@f fact\n  holds p\n')), []);
  assert.ok(codes(run('@f fact\n  holds p a b c d e f g\n')).includes('bad_atom'));
});

test('the validator command line: grammar tables, authoring mode and the exit status', () => {
  const cli = path.resolve('eval/smoke-reasoning/validator.mjs');
  assert.equal(execFileSync('node', [cli, '--grammar-compact']).toString().trim(), grammarCompact().trim());
  assert.match(execFileSync('node', [cli, '--grammar']).toString(), /\| `norm` \|/);
  assert.match(execFileSync('node', [cli, '--grammar-compact', 'fact,rule']).toString(), /^- `@id fact`.*\n- `@id rule`.*\n- governance/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'good.sop'), '@a predicate\n  args subject:entity\n@r rule\n  when a ?x\n  then a ?x\n  approval approved\n  approved_by "x"\n  approved_at 2026-01-01\n');
    fs.writeFileSync(path.join(dir, 'bad.sop'), '@a predicate\n  args subject:entity\n@r rule\n  when a ?x\n  then b ?y\n');
    const ok = spawnSync('node', [cli, '--authoring', path.join(dir, 'good.sop')]);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout.toString(), /governance_ignored/);
    const bad = spawnSync('node', [cli, path.join(dir, 'bad.sop')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout.toString(), /unsafe_head/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
