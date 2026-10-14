/**
 * Writes the circuits and expected answers of cases 74 to 79 (vrc-sopr-agent). Cases 70 to 73 (numeric action, extension E2) are written
 * by `vrc-worlds.mjs write` into `cases-pending/` until `sop/knowledge/` imports `numeric-action.mjs`.
 * Run: node eval/smoke-reasoning/bench/cases-70-79.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cases');
const put = (dir, {knowledge, query, expected, readme}) => {
  const d = path.join(root, dir);
  fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(d, 'knowledge.sop'), knowledge);
  fs.writeFileSync(path.join(d, 'query.sop'), query);
  fs.writeFileSync(path.join(d, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  fs.writeFileSync(path.join(d, 'README.md'), readme);
};

// ---------------------------------------------------------------------------------------------------------------- 74
{
  const lines = ['@machine predicate\n  args subject:entity', '@in_zone predicate\n  args subject:entity location:entity', '@overloaded predicate\n  args subject:entity', '@alert predicate\n  args subject:entity', '@escalated predicate\n  args subject:entity'];
  const facts = [];
  for (let i = 0; i <= 10; i++) facts.push(`m${i} z${i}`);
  for (let j = 0; j < 60; j++) facts.push(`f${j} g${j % 12}`);
  const body = facts.map((f, k) => { const [m, z] = f.split(' '); return `@fm${k} fact\n  holds machine ${m}\n@fz${k} fact\n  holds in_zone ${m} ${z}`; });
  const knowledge = lines.join('\n') + '\n\n' + body.join('\n') + '\n\n@fo0 fact\n  holds overloaded m0\n\n@r_alert rule\n  when overloaded ?m\n  then alert ?m\n@r_escalate rule\n  when alert ?m\n  when in_zone ?m ?z\n  then escalated ?z\n';
  const sup = Array.from({length: 10}, (_, i) => `@s${i + 1} fact\n  holds overloaded m${i + 1}\n  status supposed\n`).join('\n');
  const query = sup + '\n@q query\n  where escalated ?z\n  select ?z\n' + Array.from({length: 10}, (_, i) => `  if $s${i + 1}\n`).join('');
  const rows = [{z: 'z0'}, ...Array.from({length: 10}, (_, i) => ({z: `z${i + 1}`}))];
  put('74-whatif-many-worlds', {
    knowledge, query,
    expected: {feature: 'Many what-if worlds over one base: ten independent suppositions, each answer row names exactly the supposition it needs', status: 'supported', complete: true, rows, conditional: Array.from({length: 10}, (_, i) => `s${i + 1}`), row_conditional: [{row: {z: 'z0'}, conditional: []}, ...Array.from({length: 10}, (_, i) => ({row: {z: `z${i + 1}`}, conditional: [`s${i + 1}`]}))], requires: ['whatif', 'rules', 'conjunction']},
    readme: `# 74-whatif-many-worlds

**Reasoning feature exercised:** Many hypothetical worlds over one base (proposal backlog N06; the sop-r copy-on-write worlds).

A base of 71 machines in zones; machine m0 is overloaded (observed), so zone z0 is escalated. Ten supposed facts s1 to s10 each say that one more machine (m1 to m10, each alone in its zone) is overloaded. The question "which zones are escalated, if all ten hold?" is answered by the host as one world, and its per-row \`conditional\` list needs a world for the full set, one for each leave-one-out and one verification world per row: more than twenty sibling worlds over the same base.

**Expected answer:** z0 (unconditional) and z1 to z10, each conditional on exactly its own supposition s_i.

**Needs:** whatif, rules, conjunction. The strategy \`worlds-sopr\` answers the conditional lowering as forks of one engine.
`
  });
}

// ---------------------------------------------------------------------------------------------------------------- 75
{
  const ships = Array.from({length: 30}, (_, i) => i);
  const item = i => (i === 7 || i === 9 ? 'solvent' : `i${i}`);
  const facts = ships.flatMap(i => [`@sh${i} fact\n  holds shipment s${i}`, `@pd${i} fact\n  holds paid s${i}`, `@ct${i} fact\n  holds contains s${i} ${item(i)}`, `@cu${i} fact\n  holds contains s${i} extra${i}`]);
  const knowledge = '@shipment predicate\n  args subject:entity\n@paid predicate\n  args subject:entity\n@contains predicate\n  args subject:entity object:entity\n@dangerous predicate\n  args subject:entity\n@flagged predicate\n  args subject:entity\n  closed true\n@clear predicate\n  args subject:entity\n  closed true\n@shippable predicate\n  args subject:entity\n\n' + facts.join('\n') + '\n\n@r_flag rule\n  when contains ?s ?i\n  when dangerous ?i\n  then flagged ?s\n@r_clear rule\n  when shipment ?s\n  when absent flagged ?s\n  then clear ?s\n@r_ship rule\n  when clear ?s\n  when paid ?s\n  then shippable ?s\n';
  const query = '@s1 fact\n  holds dangerous solvent\n  status supposed\n\n@q query\n  where shippable ?s\n  select ?s\n  if $s1\n';
  const rows = ships.filter(i => i !== 7 && i !== 9).map(i => ({s: `s${i}`}));
  put('75-whatif-nonmonotone-cone', {
    knowledge, query,
    expected: {feature: 'A what-if addition flips a negation-as-failure conclusion two levels down: the answer loses rows and says it is non-monotone', status: 'supported', complete: true, rows, conditional: ['s1'], nonmonotone: true, requires: ['naf', 'closed_world', 'closed_derived', 'whatif', 'rules']},
    readme: `# 75-whatif-nonmonotone-cone

**Reasoning feature exercised:** The forward cone of a what-if reaches a negation as failure (backlog N07), so the world must recompute, not continue incrementally.

Thirty shipments, each with two items; shipments s7 and s9 contain \`solvent\`. A shipment is flagged if it contains a dangerous item, clear if it is not flagged (\`absent\`, over a closed derived predicate) and shippable if it is clear and paid. The supposition s1 says that solvent is dangerous: it ADDS a fact and REMOVES the shippable rows s7 and s9 two levels downstream.

**Expected answer:** the 28 other shipments, conditional on s1, and \`nonmonotone: true\` (the observed-only run has rows the full run lacks).

**Needs:** naf, closed_world, closed_derived, whatif, rules.
`
  });
}

// ------------------------------------------------------------------------------------------------------- 76 and 77
const hitFamily = ({n = 40, extra = '', hitRule}) => {
  let k = '@a predicate\n  args subject:entity object:entity\n@b predicate\n  args subject:entity object:entity\n@c predicate\n  args subject:entity\n@d predicate\n  args subject:entity\n@hit predicate\n  args subject:entity object:entity\n\n';
  for (let i = 0; i < n; i++) k += `@fa${i} fact\n  holds a n${i} m${i % 10}\n@fb${i} fact\n  holds b m${i % 10} o${i}\n`;
  for (let i = 0; i < 3; i++) k += `@fc${i} fact\n  holds c n${i}\n`;
  return k + extra + '\n' + hitRule;
};
const HIT_V1 = '@r_hit rule\n  when a ?x ?y\n  when b ?y ?z\n  when c ?x\n  then hit ?x ?z\n';
{
  const knowledge = hitFamily({hitRule: HIT_V1});
  const rows = [0, 10, 20, 30].map(i => ({z: `o${i}`}));
  put('76-dream-equivalence', {
    knowledge, query: '@q query\n  where hit n0 ?z\n  select ?z\n',
    expected: {feature: 'Dream equivalence: a frozen deployment plan (a certified join order) gives the same answer as the plain run', status: 'supported', complete: true, rows, requires: ['rules', 'conjunction']},
    readme: `# 76-dream-equivalence

**Reasoning feature exercised:** The dreaming wrapper (proposal 5.6, backlog N01): after a journal of tasks of one query family, offline consolidation certifies a skill and the online run uses the frozen plan; the answer must be identical.

The rule \`hit\` joins \`a\`, \`b\` and \`c\` in the worst written order (the 40-row relation \`b\` is scanned for every \`a\` row before the 3-row \`c\` filters). The wrapper reorders the body atoms (a legal plan), certifies the reorder by shadow replay against the plain run, and answers with the plan.

**Expected answer:** o0, o10, o20, o30 (n0 is in \`c\`; its \`a\` row points at m0; \`b\` links m0 to o0, o10, o20 and o30).

**Needs:** rules, conjunction. The smoke adapter returns the answer of the deployed plan; the unit test \`tests/engines/strategy-dreaming-session.test.mjs\` reports the probes and the wall clock with and without it.
`
  });
  const v2 = '@new_r_hit_v2 rule\n  when a ?x ?y\n  when b ?y ?z\n  when c ?x\n  when d ?z\n  then hit ?x ?z\n  version 2\n  supersedes $r_hit\n  approval approved\n  approved_by "owner"\n  approved_at 2026-06-01\n';
  const v1 = HIT_V1.replace('  then hit ?x ?z\n', '  then hit ?x ?z\n  version 1\n  approval superseded\n  approved_by "owner"\n  approved_at 2026-01-01\n');
  const knowledge2 = hitFamily({extra: '@fd0 fact\n  holds d o0\n@fd1 fact\n  holds d o20\n', hitRule: v1 + '\n' + v2});
  put('77-dream-gate-schema-change', {
    knowledge: knowledge2, query: '@q query\n  where hit n0 ?z\n  select ?z\n',
    expected: {feature: 'Dream gate: a plan certified on the old schema is retired on re-certification when the rule changes, and the answer is the new schema\'s', status: 'supported', complete: true, rows: [{z: 'o0'}, {z: 'o20'}], requires: ['rules', 'conjunction', 'versions']},
    readme: `# 77-dream-gate-schema-change

**Reasoning feature exercised:** The acceptance rule of a learned artefact (proposal 5.6, backlog N02): re-certify on load, shadow, revoke or quarantine. A plan is bound to the contract of its schema cone.

Version 1 of \`hit\` joins a, b and c. The wires named \`new_*\` are the schema change: version 2 (approved later, supersedes version 1) adds the filter \`d ?z\`. The adapter lets the session dream on the old schema (the \`new_*\` wires removed, the superseded rule back in force), then asks the new one.

**Expected answer:** o0 and o20 only (the rows of version 1 that also satisfy \`d\`). The plan certified on version 1 is retired on load (its contract no longer matches), its skill is quarantined, and the wrapped strategy answers plainly; a plan applied blindly to the changed rule would reorder the wrong atoms.

**Needs:** rules, conjunction, versions.
`
  });
}

// ---------------------------------------------------------------------------------------------------------------- 78 and 79
{
  const edges = [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n1'], ['n2', 'n4'], ['n4', 'n5'], ['n0', 'n6'], ['n6', 'n7'], ['n8', 'n9'], ['n9', 'n8'], ['n7', 'n5']];
  const kn = (step) => '@edge predicate\n  args source:entity destination:entity\n@reaches predicate\n  args source:entity destination:entity\n\n' + edges.map(([a, b], i) => `@e${i} fact\n  holds edge ${a} ${b}`).join('\n') + '\n\n@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n\n' + step;
  const left = '@r_step rule\n  when reaches ?x ?m\n  when edge ?m ?y\n  then reaches ?x ?y\n';
  put('78-closure-bound-argument', {
    knowledge: kn(left), query: '@q query\n  where reaches n0 ?t\n  select ?t\n',
    expected: {feature: 'Native closure template: a left-linear transitive closure with the first argument bound (answers equal the rules, by one BFS)', status: 'supported', complete: true, rows: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map(t => ({t})), requires: ['rules', 'recursion']},
    readme: `# 78-closure-bound-argument

**Reasoning feature exercised:** The native closure template (router rule, proposal 10.2, backlog N18): \`reaches\` is the transitive closure of \`edge\`, written left-linear this time, with a cycle (n1 n2 n3), a diamond into n5 and a disconnected component (n8 n9).

**Expected answer:** from n0 one reaches n1, n2, n3, n4, n5, n6, n7 (not n0, which no edge returns to, and not n8 or n9).

**Needs:** rules, recursion. \`closure-template\` answers it with one BFS; the oracle and the Datalog engines with the rules.
`
  });
  const right = '@r_step rule\n  when edge ?x ?m\n  when reaches ?m ?y\n  then reaches ?x ?y\n';
  const small = '@edge predicate\n  args source:entity destination:entity\n@reaches predicate\n  args source:entity destination:entity\n\n@e0 fact\n  holds edge a b\n@e1 fact\n  holds edge b c\n\n@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n\n' + right;
  put('79-closure-no-bound-argument', {
    knowledge: small, query: '@q query\n  where reaches ?x ?y\n  select ?x ?y\n',
    expected: {feature: 'The closure template does not fire without a bound argument: every pair is asked, the rules answer', status: 'supported', complete: true, rows: [{x: 'a', y: 'b'}, {x: 'a', y: 'c'}, {x: 'b', y: 'c'}], requires: ['rules', 'recursion']},
    readme: `# 79-closure-no-bound-argument

**Reasoning feature exercised:** The router rule of the native closure template needs a bound argument (a BFS from one node); with both arguments free the template is \`not_expressible\` and the rules answer (a sound refusal, not a weaker answer).

**Expected answer:** (a,b), (a,c), (b,c).

**Needs:** rules, recursion.
`
  });
}
console.log('written cases 74 to 79');
