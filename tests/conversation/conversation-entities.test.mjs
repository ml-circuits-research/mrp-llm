import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '../../server/agent.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {context} from '../helpers.mjs';

const WORLD = `@person entity
  kind class
  label en "person"
@organization entity
  kind class
  label en "organization"
@works_at predicate
  args subject:entity object:entity
  role subject person
  role object organization
  label en "works at"
@lx_works_at lexeme
  of works_at
  language en
  pos verb
  form "work at"
  frame subject object
@mary_the_jewess entity
  kind person
  label en "Mary the Jewess"
  alias en "Maria"
  notability 3
@albert_einstein entity
  kind person
  label en "Albert Einstein"
  notability 321
@alfred_einstein entity
  kind person
  label en "Alfred Einstein"
  notability 40
@hans_albert_einstein entity
  kind person
  label en "Hans Albert Einstein"
  notability 12
@paris entity
  kind organization
  label en "Paris"
  notability 500
@gaston_paris entity
  kind person
  label en "Gaston Paris"
  notability 20
@alpha_lab entity
  kind organization
  label en "Alpha Lab"
`;
const lexicon = new Lexicon(WORLD);
const stated = (subject, object) => `@s stated\n  relation "work at"\n  role subject ${JSON.stringify(subject)}\n  role object ${JSON.stringify(object)}\n  polarity affirmed\n  certainty asserted`;
const ask = subject => `@q query\n  select ?x\n  where match\n    relation "work at"\n    role subject ${JSON.stringify(subject)}\n    role object ?x\n    polarity affirmed\n  end`;

async function conversation(t, turns) {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  const agent = new Agent({repo: c.repo, session: c.session, lexicon, config: {}});
  const out = [];
  for (const [message, sop] of turns) out.push(await agent.turn(message, {language: 'en', formalizer: {formalize: async () => sop}}));
  return out;
}

test('a name the user introduces takes precedence over a memory namesake that only has it as an alias, and is never merged with it', async t => {
  const [noted, answer] = await conversation(t, [['Maria works at Alpha Lab.', stated('Maria', 'Alpha Lab')], ['Where does Maria work?', ask('Maria')]]);
  assert.equal(noted.packet.status, 'context_updated');
  const link = noted.packet.linking.find(l => l.surface === 'Maria');
  assert.equal(link.symbol, 'local_maria');
  assert.equal(link.via, 'conversation');
  assert.deepEqual(link.shadowed, ['mary_the_jewess']);
  assert.equal(answer.packet.status, 'supported');
  assert.deepEqual(answer.packet.answers.map(a => a.binding['?x']), ['alpha_lab']);
  assert.ok(answer.packet.origins.some(x => x.origin === 'conversation' && x.kind === 'statement'));
  assert.ok(answer.packet.proof.some(x => x.evidence?.local === true && x.atom.a[0] === 'local_maria'));
  assert.doesNotMatch(JSON.stringify(answer.packet.proof), /mary_the_jewess/);
});

test('a name the memory does not know at all is introduced by a statement; in a question alone it stays an entity question', async t => {
  // 2026-10-02 (eval-generality-v1): "My friend Zork lives in Lisbon." then "Is Zork in Portugal?" must use the statement.
  const [noted, answer] = await conversation(t, [['Zorica works at Alpha Lab.', stated('Zorica', 'Alpha Lab')], ['Where does Zorica work?', ask('Zorica')]]);
  assert.notEqual(noted.packet.status, 'clarify');
  assert.ok(noted.packet.linking.some(l => l.symbol === 'local_zorica' && l.via === 'conversation'));
  assert.ok(answer.packet.answers.length > 0, JSON.stringify(answer.packet));
  const [alone] = await conversation(t, [['Where does Zorica work?', ask('Zorica')]]);
  assert.equal(alone.packet.status, 'clarify');
  assert.match(alone.text, /Which entity do you mean by "Zorica"/);
});

test('without a statement about it, the same alias still reaches the memory entity', async t => {
  const [answer] = await conversation(t, [['Where does Maria work?', ask('Maria')]]);
  assert.ok(!answer.packet.linking.some(l => l.symbol === 'local_maria'));
  assert.equal(answer.packet.answers.length, 0);
});

test('a name with a label in the memory is the memory entity, not a conversation entity', async t => {
  const [noted] = await conversation(t, [['Albert Einstein works at Alpha Lab.', stated('Albert Einstein', 'Alpha Lab')]]);
  assert.deepEqual(noted.packet.linking.filter(l => l.kind === 'entity').map(l => l.symbol).sort(), ['albert_einstein', 'alpha_lab']);
});

test('a surname alone yields every person that carries it, ranked by notability', () => {
  const found = lexicon.matching('Einstein', {language: 'en', kind: 'entity'}).found.map(e => e.id).sort();
  assert.deepEqual(found, ['albert_einstein', 'alfred_einstein', 'hans_albert_einstein']);
  assert.equal(lexicon.entities.albert_einstein.aliases.find(a => a.derived === 'name_part').surface, 'Einstein');
  assert.equal(lexicon.matching('Gruber', {language: 'en', kind: 'entity'}).found.length, 0);
  assert.equal(lexicon.entities.alpha_lab.aliases.some(a => a.derived), false, 'only persons get name parts');
});

test('a name part is only a fallback: where a label carries the surface, the surnames are not candidates', () => {
  assert.deepEqual(lexicon.matching('Paris', {language: 'en', kind: 'entity'}).found.map(e => e.id), ['paris']);
  assert.deepEqual(lexicon.matching('Gaston Paris', {language: 'en', kind: 'entity'}).found.map(e => e.id), ['gaston_paris']);
});
