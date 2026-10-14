import test from 'node:test';
import assert from 'node:assert/strict';
import {validateQuery} from '../../lib/query-author/validate.mjs';
import {lex} from '../helpers.mjs';

const match = (relation, subject, object) => `  where match\n    relation "${relation}"\n    role subject ${subject}\n    role object ${object}\n    polarity affirmed\n  end\n`;
const people = [
  {surface: 'Ana', candidates: ['ana'], strong: true},
  {surface: 'Bogdan', candidates: ['bogdan'], strong: true}
];
const age = `@q query\n  select ?person\n${match('age', '?person', '?years')}`;
const options = `  compare any\n    ?person equal "Ana"\n    ?person equal "Bogdan"\n  end\n`;
const ranked = `@q query\n  select ?person\n  rank highest ?years\n${options}${match('age', '?person', '?years')}`;
const check = (sop, message, mentions = null, extra = {}) => validateQuery({sop, message, mentions, lexicon: lex, ...extra});
const codes = result => result.problems.map(problem => problem.code);

// No hardcoded understanding (AGENTS.md): the validator checks the circuit against the SOP language and the memory, never against
// the phrasing of the message. Quantifiers, options and comparisons are the formalizer's understanding; their explicit forms admit.
test('the validator does not read the phrasing: quantifier, option and comparison forms are the formalizer\'s understanding', () => {
  const base = `@q query\n  mode every\n${match('works_at', '?person', '"Alpha Lab"')}  scope match\n    relation "age"\n    role subject ?person\n    role object ?years\n    polarity affirmed\n  end\n`;
  assert.equal(check(base, 'Do most employees at Alpha Lab have an age?').ok, true, 'no word list decides that "most" was dropped');
  assert.equal(check(base.replace('  mode every\n', '  mode every\n  quantifier most\n'), 'Do most employees at Alpha Lab have an age?').ok, true);
  assert.equal(check(base.replace('  mode every\n', '  mode every\n  quantifier at_least 3\n'), 'Do at least 3 employees at Alpha Lab have an age?').ok, true);
  assert.equal(check(ranked, 'Which is older, Ana or Bogdan?', people).ok, true);
  assert.equal(check(`@q query\n  select ?person\n  compare ?years at_least 3\n${match('age', '?person', '?years')}`, 'Which employees are at least 3 years old?').ok, true);
});

test('a name repeated only in an unused assumed proposition does not cover the question', () => {
  const assumption = `@a assumed\n  relation "age"\n  role subject "Bogdan"\n  role object 35\n  polarity affirmed\n  basis world\n`;
  const query = `@q query\n  select ?years\n${match('age', '"Ana"', '?years')}`;
  const result = check(assumption + query, 'How old are Ana and Bogdan?', people);
  assert.deepEqual(codes(result), ['mention_not_used']);
  assert.equal(check(query.replace('"Ana"', '"Bogdan"'), 'How old is Bogdan?', [people[1]]).ok, true);
});

test('explicit named numeric unknowns cover mentions only when one problem constrains both', () => {
  const message = "Let x be Ana's assignment and y be Bogdan's assignment. Both are integers from 0 to 4 inclusive. Is there an assignment where x plus y equals 5, twice x plus y equals 6, and x is less than y? Give x and y if possible.";
  const mentions = [
    {surface: "Ana's", candidates: ['ana'], strong: true},
    {surface: "Bogdan's", candidates: ['bogdan'], strong: true}
  ];
  const complete = '@c constraint\n  var ?x int 0 4\n  var ?y int 0 4\n  require ?x plus ?y equal 5\n  require 2 times ?x plus ?y equal 6\n  require ?x below ?y\n  task possible\n  select ?x ?y\n';
  assert.equal(check(complete, message, mentions).ok, true);
  const dropped = complete.replace('  require ?x plus ?y equal 5\n  require 2 times ?x plus ?y equal 6\n  require ?x below ?y\n', '  claim ?x equal 1\n');
  assert.deepEqual(codes(check(dropped, message, mentions)), ['mention_not_used'], 'a declared but unconstrained y does not use Bogdan');
  const split = '@left constraint\n  var ?x int 0 4\n  claim ?x equal 1\n  task possible\n@right constraint\n  var ?y int 0 4\n  claim ?y equal 2\n  task possible\n';
  assert.deepEqual(codes(check(split, message, mentions)), ['constraint_split'], 'independent problems do not express one conjunctive assignment');
  const repeated = '@left constraint\n  var ?x int 0 4\n  var ?y int 0 4\n  claim ?x plus ?y equal 5\n  task possible\n@right constraint\n  var ?x int 0 4\n  var ?y int 0 4\n  claim 2 times ?x plus ?y equal 6\n  task possible\n';
  assert.deepEqual(codes(check(repeated, message, mentions)), ['constraint_split'], 'repeating both variables does not join two independently solved claims');
  assert.deepEqual(codes(check(complete.replace('  require ?x below ?y\n', ''), message, [{surface: 'Unmentioned', candidates: ['unmentioned'], strong: true}])), ['mention_not_used'], 'names with no explicit numeric binding still require a query value');
});

test('query variables selected, compared or excluded must be bound in every where alternative', () => {
  const base = '@q query\n  where match\n    relation "age"\n    role subject ?person\n    role object ?years\n    polarity affirmed\n  end\n';
  assert.deepEqual(codes(check(base.replace('  where', '  select ?missing\n  where'), 'What age?')), ['unbound_query_variable']);
  assert.deepEqual(codes(check(base.replace('  where', '  compare ?years above ?missing\n  where'), 'Is the age above a second age?')), ['unbound_query_variable']);
  assert.deepEqual(codes(check(base.replace('  where', '  except ?missing "Ana"\n  where'), 'Who besides Ana?')), ['unbound_query_variable']);
  assert.equal(check(base.replace('  where', '  select ?years\n  compare ?years above 1\n  where'), 'What age above one?').ok, true);
  const alternative = '@q query\n  select ?years\n  where any\n    match\n      relation "age"\n      role subject "Ana"\n      role object ?years\n      polarity affirmed\n    end\n    match\n      relation "age"\n      role subject "Bogdan"\n      role object ?other\n      polarity affirmed\n    end\n  end\n';
  assert.deepEqual(codes(check(alternative, 'How old are Ana and Bogdan?')), ['unbound_query_variable']);
  assert.equal(check(alternative.replace('?other', '?years'), 'How old are Ana and Bogdan?').ok, true);
});
