import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../../tools/eval/symbolic-vs-llm/world.mjs';
import {stepByStepQuery, createOracle} from '../../lib/query-author/step-by-step/index.mjs';
import {readChoice, readChoices, readLetters, readExpression, readComparison, readUnknowns, readDates} from '../../lib/query-author/step-by-step/answers.mjs';
import {FORMS} from '../../lib/query-author/step-by-step/prompts.mjs';

const kind = name => String(FORMS.findIndex(f => f[0] === name) + 1);
const entity = id => `@${id} entity\n  kind entity\n  label en "${id.replaceAll('_', ' ')}"\n  alias en "${id}"\n`;

/** A scripted oracle: each rule answers the first question whose text matches; every question is recorded. */
function scripted(rules) {
  const asked = [];
  const chat = async messages => {
    const question = messages.at(-1).content;
    asked.push(question);
    const rule = rules.find(r => r.when.test(question) && !r.used);
    if (!rule) return {ok: true, text: 'unknown', ms: 1, usage: {input_tokens: 10, output_tokens: 1}};
    if (rule.once) rule.used = true;
    return {ok: true, text: typeof rule.say === 'function' ? rule.say(question) : rule.say, ms: 1, usage: {input_tokens: 10, output_tokens: 1}, cached: 8, evaluated: 2};
  };
  return {chat, asked};
}
const lineOf = (question, words) => question.split('\n').find(l => /^\d+\./.test(l) && l.includes(words))?.match(/^(\d+)\./)?.[1];

test('answer readers take numbers, lettered places, dates and arithmetic, and refuse anything else', () => {
  assert.equal(readChoice('**3**. count', 9), 3);
  assert.equal(readChoice('12', 9), null);
  assert.deepEqual(readChoices('1, 3 and 3', 4), [1, 3]);
  assert.deepEqual(readChoices('none', 4), [0]);
  assert.deepEqual(readLetters('A: 2\nB = 1', ['A', 'B'], 3), {A: 2, B: 1});
  assert.equal(readLetters('A: 2', ['A', 'B'], 3), null, 'every place needs an answer');
  assert.equal(readExpression('2x + y', ['x', 'y']), '2 times ?x plus ?y');
  assert.equal(readExpression('2*(x+y)', ['x', 'y']), null, 'parentheses are refused, never re-associated');
  assert.equal(readExpression('x + z', ['x', 'y']), null, 'an undeclared name is refused');
  assert.deepEqual(readComparison('- x <= 2y - 1', ['x', 'y']), {left: '?x', comparator: 'at_most', right: '2 times ?y minus 1'});
  assert.deepEqual(readUnknowns('x: 0 to 10\ny from 1 to 4'), [{name: 'x', min: 0, max: 10}, {name: 'y', min: 1, max: 4}]);
  assert.deepEqual(readDates('overlapping April 1 to May 1, 2026'), ['2026-04-01', '2026-05-01']);
  assert.deepEqual(readDates('2026-02-30'), [], 'an impossible date is not a date');
});

test('a count is assembled by the system from a kind choice, a statement number and the places of the statement', async () => {
  const knowledge = [entity('firm_a'), entity('ana'), entity('ion'), '@assigned_to predicate\n  args subject:entity object:entity\n',
    '@f1 fact\n  holds assigned_to ana firm_a\n', '@f2 fact\n  holds assigned_to ion firm_a\n'].join('');
  const world = createWorld(knowledge);
  try {
    const {chat, asked} = scripted([
      {when: /Which kind of answer/, say: kind('count')},
      {when: /Which statements does the request need/, say: q => lineOf(q, 'assigned to')},
      {when: /what are A and B/, say: q => `A: ${lineOf(q, 'asks for')}\nB: ${lineOf(q, 'firm_a')}`},
      {when: /Is this what the request asks/, say: 'yes'},
    ]);
    const r = await stepByStepQuery({message: 'How many distinct people are assigned to firm_a?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat})});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /mode count/);
    assert.match(r.sop, /relation "assigned_to"\n\s+role subject \?x\n\s+role object "firm_a"/);
    assert.equal(r.steps.length, 4);
    assert.ok(asked.every(q => !/```|\{"/.test(q)), 'no question asks for code or JSON');
  } finally { world.dispose(); }
});

test('reachability is a recursive session definition the system writes; the model only names step, avoided statement and start', async () => {
  const knowledge = [entity('s1'), entity('s2'), entity('s3'), '@link predicate\n  args subject:entity object:entity\n', '@blocked predicate\n  args subject:entity\n  closed true\n',
    '@f1 fact\n  holds link s1 s2\n', '@f2 fact\n  holds link s2 s3\n'].join('');
  const world = createWorld(knowledge);
  try {
    const {chat} = scripted([
      {when: /Which kind of answer/, say: kind('reach')},
      {when: /Must the chain avoid/, say: q => lineOf(q, 'blocked')},
      {when: /starting point/, say: q => lineOf(q, ' s1')},
      {when: /Is this what the request asks/, say: 'yes'},
    ]);
    const r = await stepByStepQuery({message: 'Can one reach s3 from s1 without entering a blocked station?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat})});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /default\n\s+when link \?from \?to\n\s+then allowed_link \?from \?to\n\s+except blocked \?to/);
    assert.match(r.sop, /role subject "s1"\n\s+role object "s3"/);
  } finally { world.dispose(); }
});

test('a "no" at the confirmation redoes the doubtful step once; absence is offered only for a closed statement', async () => {
  const knowledge = [entity('ana'), entity('firm_a'), '@assigned_to predicate\n  args subject:entity object:entity\n', '@f1 fact\n  holds assigned_to ana firm_a\n'].join('');
  const world = createWorld(knowledge);
  try {
    const {chat, asked} = scripted([
      {when: /Which kind of answer/, say: kind('yesno')},
      {when: /Which statements does the request need/, say: '1'},
      {when: /what are A and B/, once: true, say: q => `A: ${lineOf(q, 'firm_a')}\nB: ${lineOf(q, 'ana')}`},
      {when: /what are A and B/, say: q => `A: ${lineOf(q, 'ana')}\nB: ${lineOf(q, 'firm_a')}`},
      {when: /Does the request ask/, say: '1'},
      {when: /Is this what the request asks/, say: 'no'},
      {when: /Which part is wrong/, say: '3'},
    ]);
    const r = await stepByStepQuery({message: 'Is ana assigned to firm_a?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat})});
    assert.equal(r.retried, 'the names and their places in the statements');
    assert.match(r.sop, /role subject "ana"\n\s+role object "firm_a"/);
    assert.ok(!asked.find(q => /Does the request ask/.test(q)).includes('absent'), 'an open statement is never asked about absence');
    assert.equal(asked.filter(q => /Is this what the request asks/.test(q)).length, 1, 'one confirmation, at most one retry');
  } finally { world.dispose(); }
});

test('an unreadable answer is asked once more, then the strategy stops honestly instead of guessing', async () => {
  const world = createWorld(entity('ana'));
  try {
    const {chat} = scripted([{when: /./, say: 'I think it is about Ana.'}]);
    const r = await stepByStepQuery({message: 'Is ana here?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat})});
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /could not be read/);
    assert.equal(r.steps.length, 2);
  } finally { world.dispose(); }
});
