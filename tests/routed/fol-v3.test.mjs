/**
 * fol-v3 (2026-10-03): the formalizer's FOL for argument questions and for questions about the system's own reasoning. The reader
 * (lib/formalize/fol/parse.mjs: SUPPOSE, ASSUME, Effect, Explain, Missing, Why, Change, Assumed), the converter (to-ir.mjs: options,
 * assumptions, claims; to-sop.mjs: `candidate` wires and `mode effect` / `abduce` / `why_not` / `explain` queries, one circuit per
 * premise for Change, `assumed` wires) and each form through a chat turn (Agent.turn with the converted circuit as the formalizer's
 * output), rendered from the conversation-v1 reply lines. The examples are invented problems, never book text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseFol, showFol} from '../../lib/formalize/fol/parse.mjs';
import {folToIr} from '../../lib/formalize/fol/to-ir.mjs';
import {compileIr} from '../../lib/formalize/fol/to-sop.mjs';
import {parseTemplate} from '../../lib/prompt-template.mjs';
import {Agent} from '../../server/agent.mjs';
import {seedLexicon} from '../../lib/knowledge-seeds.mjs';
import {context} from '../helpers.mjs';

/** A line as the formalizer writes it: "? " marks a question. */
const unit = line => {
  const question = line.startsWith('?'), p = parseFol(line.replace(/^\?\s*/, ''));
  assert.ok(p.ok, `${line}: ${p.why}`);
  return {ast: p.ast, question, source: line};
};
const compile = lines => {
  const ir = folToIr(lines.map(unit));
  assert.deepEqual(ir.rejected.map(r => r.why), []);
  const out = compileIr(ir, {names: new Map()});
  assert.deepEqual(out.rejected.map(r => r.why), []);
  return {ir, circuits: out.circuits};
};

// The memory settings of the product (the chat and ChatSOPAdapter's executor run problem circuits over them).
const MEMORY = JSON.parse(fs.readFileSync(new URL('../../config/runtime.json', import.meta.url), 'utf8')).memory;

/** The circuits of a problem, each through one chat turn of its own: [{kind, value, detail, text, packet}]. */
async function chat(t, lines) {
  const c = context({bootstrap: false, memory: MEMORY});
  t.after(c.dispose);
  const out = [];
  for (const [i, circuit] of compile(lines).circuits.entries()) {
    const session = c.repo.session('base', 'fol', `s${i}`);
    const r = await new Agent({repo: c.repo, session, lexicon: seedLexicon('core-min'), config: {}}).turn(`values: ${circuit.literals.join(' ; ')}`, {language: 'en', formalizer: {formalize: async () => circuit.sop}});
    assert.ok(r.packet, r.error);
    out.push({kind: circuit.kind, value: circuit.decode(r.packet), detail: circuit.detail?.(r.packet), text: r.text, packet: r.packet, sop: circuit.sop});
  }
  return out;
}

const CARD = ['FORALLx (Rained(x) IMPLIES Wet(x))', 'Wet(market)'];

test('reader: SUPPOSE, ASSUME and the support questions are line forms; an ordinary atom of the same name stays an atom', () => {
  const kinds = ['SUPPOSE sam: FORALLx (Wet(x) IMPLIES Rained(x))', 'SUPPOSE (b): Truck(market)', 'ASSUME Bird(tweety)', 'Assumed',
    'Effect(Rained(market))', 'Explain(Open(yard) AND NOT Marks(yard))', 'Missing(Rained(market)).', 'Why(Wet(market))', 'Change(Wet(market))']
    .map(s => { const p = parseFol(s); assert.ok(p.ok, s); return p.ast.type === 'meta' ? `meta:${p.ast.kind}` : p.ast.type; });
  assert.deepEqual(kinds, ['suppose', 'suppose', 'assume', 'meta:assumed', 'meta:effect', 'meta:explain', 'meta:missing', 'meta:why', 'meta:change']);
  assert.equal(parseFol('SUPPOSE b: Truck(market)').ast.id, 'b');
  assert.equal(showFol(parseFol('Effect(Rained(market))').ast), 'Effect(Rained(market))');
  // Effect(drug, sleep) and Why(x) have no formula inside: ordinary atoms.
  assert.equal(parseFol('Effect(drug, sleep)').ast.type, 'atom');
  assert.equal(parseFol('Why(x)').ast.a.type, 'atom');
  assert.match(parseFol('SUPPOSE a: Effect(P(c))').why, /SUPPOSE takes a formula/);
});

test('converter: options are candidates, never facts; assumptions are kept apart; claims must be ground or a rule', () => {
  const {ir} = compile([...CARD, 'SUPPOSE sam: FORALLx (Wet(x) IMPLIES Rained(x))', 'SUPPOSE tess: Truck(market)', 'SUPPOSE una: Truck(market) AND Sweeper(market)', '? Effect(Rained(market))']);
  assert.deepEqual(ir.facts.map(f => f.pred), ['Wet']);
  assert.deepEqual(ir.options.map(o => [o.id, o.kind, o.part]), [['sam', 'rule', null], ['tess', 'fact', null], ['una', 'fact', 1], ['una', 'fact', 2]]);
  assert.deepEqual(ir.queries.map(q => [q.kind, q.claim.map(l => l.pred)]), [['effect', ['Rained']]]);
  const a = folToIr(['Penguin(pingu)', 'ASSUME Bird(pingu)', 'ASSUME FORALLx (Penguin(x) IMPLIES NOT Flies(x))', '? Assumed'].map(unit));
  assert.deepEqual(a.facts.map(f => f.pred), ['Penguin']);
  assert.deepEqual(a.assumed.map(x => x.kind), ['fact', 'rule']);
  // A claim with a free variable that is not a rule is refused; a number is not an option.
  assert.match(folToIr([unit('? Effect(EXISTSx Wet(x))')]).rejected[0].why, /claim of effect/);
  assert.match(folToIr([unit('SUPPOSE a: Value(price, 3)')]).rejected[0].why, /not a number/);
  // A rule as the claim is asked of an arbitrary instance.
  const r = folToIr([unit('? Why(FORALLx (Cat(x) IMPLIES Animal(x)))')]);
  assert.deepEqual([r.queries[0].given.map(l => l.pred), r.queries[0].claim.map(l => l.pred)], [['Cat'], ['Animal']]);
});

test('the circuits: candidate wires, the modes, one circuit per premise for Change, assumed wires', () => {
  const effect = compile([...CARD, 'SUPPOSE sam: FORALLx (Wet(x) IMPLIES Rained(x))', 'SUPPOSE tess: Truck(market)', '? Effect(Rained(market))']).circuits;
  assert.equal(effect.length, 1);
  assert.match(effect[0].sop, /@opt_sam rule\n {2}when f_wet \?x\n {2}then f_rained \?x/);
  assert.match(effect[0].sop, /@opt_tess stated\n {2}certainty supposed/);
  assert.match(effect[0].sop, /@q query\n {2}mode effect\n {2}candidate \$opt_sam\n {2}candidate \$opt_tess\n/);
  assert.match(effect[0].sop, /@f_rained predicate\n {2}args subject:entity\n {2}label en "rained"/);
  assert.match(compile([...CARD, '? Missing(Rained(market))']).circuits[0].sop, /mode why_not/);
  assert.match(compile([...CARD, '? Explain(Rained(market))']).circuits[0].sop, /mode why_not/, 'Explain without options asks what is missing');
  assert.match(compile(['FORALLx (Rained(x) IMPLIES Wet(x))', 'Rained(market)', '? Why(Wet(market))']).circuits[0].sop, /mode explain/);
  const change = compile(['FORALLx (Rained(x) IMPLIES Wet(x))', 'Rained(market)', 'Dog(rex)', '? Change(Wet(market))']).circuits;
  assert.deepEqual(change.map(c => c.premise), ['Rained(market)', 'Rained(?x) IMPLIES Wet(?x)'], 'only the premises the claim rests on');
  assert.match(change[0].sop, /@fs1 stated\n {2}certainty supposed\n {2}relation "f_rained"/);
  assert.match(change[0].sop, /candidate \$fs1/);
  assert.match(change[1].sop, /candidate \$fr1/);
  const assumed = compile(['Penguin(pingu)', 'ASSUME Bird(pingu)', 'ASSUME FORALLx (Penguin(x) IMPLIES NOT Flies(x))', '? NOT Flies(pingu)', '? Assumed']).circuits;
  assert.match(assumed[0].sop, /@fa1 assumed\n {2}relation "f_bird"/);
  assert.match(assumed[0].sop, /@q query\n {2}if \$fa_r1\n/);
  assert.equal(assumed[1].kind, 'assumed');
  assert.doesNotMatch(assumed[1].sop, /@q query/);
});

test('chat: Effect names what each option does to the claim; the answer is whether the claim follows', async t => {
  const [r] = await chat(t, [...CARD, 'SUPPOSE sam: FORALLx (Wet(x) IMPLIES Rained(x))', 'SUPPOSE tess: Truck(market)', '? Effect(Rained(market))']);
  assert.equal(r.kind, 'effect');
  assert.equal(r.value, false, 'the card does not prove rain');
  assert.deepEqual(r.detail.effects, [{option: 'sam', effect: 'establishes'}, {option: 'tess', effect: 'no_effect'}]);
  assert.match(r.text, /^Without any of the options, what is known says it is false\./);
  assert.match(r.text, /With the rule "opt_sam" \(if .*wet.*, then .*rained.*\), it would follow\./);
  assert.match(r.text, /truck.*changes nothing about it\./i);
  assert.doesNotMatch(r.packet.session_circuits?.text ?? '', /opt_sam/, 'an option is never stored');
});

test('chat: Explain abduces over the options and rejects the inconsistent one; Missing names the missing fact', async t => {
  const [r] = await chat(t, ['FORALLx (Forced(x) IMPLIES (Open(x) AND Marks(x)))', 'FORALLx (Key(x) IMPLIES Open(x))', 'Open(yard)', 'NOT Marks(yard)',
    'SUPPOSE forced: Forced(yard)', 'SUPPOSE key: Key(yard)', '? Explain(Open(yard))']);
  assert.equal(r.kind, 'abduce');
  assert.deepEqual(r.value, ['key']);
  assert.deepEqual(r.detail, {explanations: [['key']], necessary: ['key'], inconsistent: [['forced']]});
  assert.match(r.text, /A possible explanation: .*key.*Yard/);
  assert.match(r.text, /Rejected: .*forced.*contradict/);
  const [m] = await chat(t, [...CARD, '? Missing(Rained(market))']);
  assert.equal(m.kind, 'why_not');
  assert.equal(m.value, null, "Missing asks what is missing, not whether the claim follows");
  assert.deepEqual(m.detail.missing, [["f_rained local_market"]]);
  assert.match(m.text, /It would follow if .*rained.*Market/);
});

test('chat introspection: Why names the rules; Change tries the answer without each premise; Assumed lists the assumptions', async t => {
  const [why] = await chat(t, ['FORALLx (Cat(x) IMPLIES Mammal(x))', 'FORALLx (Mammal(x) IMPLIES Animal(x))', 'Cat(tom)', '? Why(Animal(tom))']);
  assert.equal(why.value, true);
  assert.deepEqual(why.detail.rules_used, ['fr2', 'fr1']);
  assert.match(why.text, /^Yes\./);
  assert.match(why.text, /Rule used, "fr1": if .*cat.*, then .*mammal/);
  // A rule as the claim: of an arbitrary cat, animal follows.
  const [rule] = await chat(t, ['FORALLx (Cat(x) IMPLIES Mammal(x))', 'FORALLx (Mammal(x) IMPLIES Animal(x))', '? Why(FORALLx (Cat(x) IMPLIES Animal(x)))']);
  assert.equal(rule.value, true);
  const change = await chat(t, ['FORALLx (Rained(x) IMPLIES Wet(x))', 'Rained(market)', '? Change(Wet(market))']);
  assert.deepEqual(change.map(c => [c.detail.premise, c.detail.effect, c.value]), [['Rained(market)', 'establishes', true], ['Rained(?x) IMPLIES Wet(?x)', 'establishes', true]]);
  assert.match(change[0].text, /With .*rained.*Market, it would follow\./);
  const [answer, assumed] = await chat(t, ['Penguin(pingu)', 'ASSUME Swims(pingu)', 'ASSUME FORALLx (Penguin(x) IMPLIES Bird(x))', '? Bird(pingu)', '? Assumed']);
  assert.equal(answer.value, true);
  assert.match(answer.text, /^This result depends on the stated assumptions\./, 'an answer resting on an assumed rule says so');
  assert.deepEqual(answer.packet.conditional, ['fa_r1']);
  assert.deepEqual(assumed.value, ['ASSUME Swims(pingu)', 'ASSUME FORALLx (Penguin(x) IMPLIES Bird(x))']);
  assert.equal(assumed.packet.status, 'context_updated');
  assert.match(assumed.text, /The model assumed: f_swims \(subject: pingu\)\./);
  assert.deepEqual(assumed.packet.model_assumptions.map(a => a.treatment), ['reported'], 'an assumption is reported, never a fact');
});

test('soundness: a "does not follow" is withheld when a statement it rests on was not understood', () => {
  const ir = folToIr([...CARD.map(unit), {unparsed: 'Rained(market) %% garbled', source: 'x'}, unit('? Effect(Rained(market))'), unit('SUPPOSE sam: Truck(market)')]);
  const [c] = compileIr(ir, {names: new Map()}).circuits;
  assert.equal(c.decode({status: 'unknown', effects: []}), null);
  assert.equal(c.decode({status: 'supported', effects: []}), true);
});

test('fol-v3 keeps every rule of fol-v2 and adds the argument forms', () => {
  // The role prompts are project data in config/prompts/ (Ploinky prompted roles read them from there).
  const file = name => [`../../Ploinky/prompts/${name}.md`, `../../config/prompts/${name}.md`].map(f => new URL(f, import.meta.url)).find(u => fs.existsSync(u));
  const read = name => parseTemplate(fs.readFileSync(file(name), 'utf8'));
  const v2 = read('fol-v2'), v3 = read('fol-v3');
  assert.deepEqual(v3.options, v2.options);
  assert.equal(v3.system, v2.system);
  for (const line of v2.user.split('\n').filter(l => l.startsWith('- ') || l.startsWith('Syntax:'))) assert.ok(v3.user.includes(line), `fol-v3 drops: ${line.slice(0, 60)}`);
  for (const form of ['SUPPOSE', 'ASSUME', '? Effect(', '? Explain(', '? Missing(', '? Why(', '? Change(', '? Assumed']) assert.ok(v3.user.includes(form), form);
  assert.equal(v3.again, v2.again);
});
