// The query author library (lib/query-author): retrieval, vocabulary and the validator that every step-by-step formalizer shares,
// against stubs. No test calls a model. The one-shot author's tests are archived in probably_obsolete/one-shot-formalization/tests/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatePredicates, entityHints, predicateRecall, renderCandidates, renderVocabulary, unclearKind, validateQuery, stem} from '../../lib/query-author/index.mjs';
import {lex} from '../helpers.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {admitModel} from '../../lib/query-author/admit.mjs';

const Q = (relation, subject, object) => `@q query\n  where match\n    relation "${relation}"\n    role subject "${subject}"\n    role object "${object}"\n    polarity affirmed\n  end\n`;
const GOOD = Q('works_at', 'ana', 'lab_alpha');

test('retrieval: predicates by message match with a core set, entity hints with candidates, recall', () => {
  assert.equal(stem('wrote'), stem('write'));
  assert.equal(stem('founded'), stem('found'));
  const found = candidatePredicates('Where does Ana work at?', lex, {k: 5});
  assert.ok(found.slice(0, 5).some(c => c.id === 'works_at'), JSON.stringify(found));
  assert.ok(found.some(c => c.id === 'is_a'), 'the core set is always offered');
  assert.equal(predicateRecall(found, ['works_at']), 1);
  assert.equal(predicateRecall(found, ['works_at', 'no_such_predicate']), 0.5);
  assert.equal(predicateRecall(found, []), null);
  const hints = entityHints('Does Ana work at Lab Alpha?', lex);
  assert.ok(hints.some(m => m.candidates.some(c => c.id === 'ana')), JSON.stringify(hints));
  assert.ok(hints.every(m => m.candidates.length <= 3));
  assert.deepEqual(entityHints('xyzzy plugh', lex), []);
});

test('vocabulary: the full list is bounded and says when it is cut; candidates carry id, roles and phrases', () => {
  const v = renderVocabulary(lex);
  assert.equal(v.truncated, false);
  const small = renderVocabulary(lex, {maxBytes: 900});
  assert.equal(small.truncated, true);
  assert.match(small.text, /The list is cut/);
  const text = renderCandidates(lex, [{id: 'works_at'}]);
  assert.match(text, /- works_at \(subject:person, object:organization\)/);
  assert.match(text, /kind relation_not_in_memory/);
});

test('validator, id mode: only queries; predicate ids of the memory, declared roles, listed entity ids, class fit', () => {
  const ok = validateQuery({sop: GOOD, message: 'x', lexicon: lex, hints: new Set(['ana', 'lab_alpha'])});
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  const phrase = validateQuery({sop: Q('work at', 'Ana', 'Lab Alpha'), message: 'x', lexicon: lex});
  assert.equal(phrase.ok, false);
  assert.equal(phrase.problems[0].code, 'unknown_predicate');
  assert.match(phrase.problems[0].message, /nearest: .*works_at\(subject:person, object:organization\)/);
  const role = validateQuery({sop: '@q query\n  where match\n    relation "works_at"\n    role subject "Ana"\n    role location "Cluj"\n    polarity affirmed\n  end\n', message: 'x', lexicon: lex});
  assert.equal(role.problems[0].code, 'undeclared_role');
  assert.equal(validateQuery({sop: '@q query\n  where match\n    relation "works_at"\n    role subject "Ana"\n    role object ?o\n    role time ?t\n    polarity affirmed\n  end\n', message: 'x', lexicon: lex}).ok, true, 'time is host work');
  const unlisted = validateQuery({sop: GOOD, message: 'x', lexicon: lex, hints: new Set(['bogdan'])});
  assert.equal(unlisted.problems[0].code, 'entity_id_not_listed');
  const clash = validateQuery({sop: Q('works_at', 'ana', 'maria'), message: 'x', lexicon: lex, hints: new Set(['ana', 'maria'])});
  assert.equal(clash.problems[0].code, 'class_mismatch');
  const asserted = validateQuery({sop: '@s stated\n  relation "works_at"\n  role subject "Ana"\n  role object "Acme"\n  polarity affirmed\n  certainty asserted\n', message: 'Ana works at Acme', lexicon: lex});
  assert.equal(asserted.ok, true, 'a statement of the message is turn-local evidence (stated, certainty asserted)');
  const invented = validateQuery({sop: '@s stated\n  relation "works_at"\n  role subject "Ana"\n  role object "Acme"\n  polarity affirmed\n  certainty asserted\n', message: 'Bob works at Initech', lexicon: lex});
  assert.equal(invented.problems[0].code, 'stated_value_not_in_message', 'a stated value must come from the message');
  const assumption = '@a assumed\n  relation "works_at"\n  role subject "Ana"\n  role object "Acme"\n  polarity affirmed\n  basis world\n';
  assert.equal(validateQuery({sop: assumption, message: 'x', lexicon: lex}).problems[0].code, 'no_query');
  assert.equal(validateQuery({sop: assumption + Q('works_at', 'Ana', 'Acme'), message: 'Does Ana work at Acme?', lexicon: lex}).ok, true);
  assert.equal(validateQuery({sop: '@f fact\n  holds works_at ana lab_alpha\n', message: 'x', lexicon: lex}).ok, false, 'raw facts are never authored');
  assert.equal(validateQuery({sop: '', message: 'x', lexicon: lex}).problems[0].code, 'missing_output');
  assert.equal(validateQuery({sop: '@q query\n  where bogus\n', message: 'x', lexicon: lex}).ok, false);
  const gap = validateQuery({sop: '@u unclear\n  kind relation_not_in_memory\n', message: 'Who is the godfather of Ana?', lexicon: lex});
  assert.equal(gap.ok, true);
  assert.equal(unclearKind(gap.program), 'relation_not_in_memory');
  const unclear = validateQuery({sop: '@u unclear\n  kind no_request\n', message: 'thanks', lexicon: lex});
  assert.equal(unclearKind(unclear.program), 'no_request');
});

test('declared roles are checked through grouped matches at direct chat admission', () => {
  const invalid = '@q query\n  mode every\n  where match\n    relation "works_at"\n    role subject ?person\n    polarity affirmed\n  end\n  scope any\n    match\n      relation "works_at"\n      role subject ?person\n      role location "Cluj"\n      polarity affirmed\n    end\n  end\n';
  assert.throws(() => admitModel(invalid, 'Does everyone work in Cluj?', lex), /undeclared_role: works_at has no role location/);
  assert.deepEqual(validateQuery({sop: invalid, message: 'Does everyone work in Cluj?', lexicon: lex}).problems.map(p => p.code), ['undeclared_role']);
  const assumption = '@a assumed\n  relation "works_at"\n  role subject "Ana"\n  role location "Cluj"\n  polarity affirmed\n';
  assert.throws(() => admitModel(assumption, 'Ana in Cluj', lex), /undeclared_role: works_at has no role location/);
  assert.equal(admitModel('@s stated\n  relation "works_at"\n  role subject "Ana"\n  role object "Lab Alpha"\n  role time "2025"\n  polarity affirmed\n  certainty supposed\n', 'Ana worked at Lab Alpha in 2025', lex).wires.length, 1);
  const partial = '@q query\n  select ?person\n  where match\n    relation "works_at"\n    role subject ?person\n    polarity affirmed\n  end\n';
  assert.equal(validateQuery({sop: partial, message: 'Who works?', lexicon: lex}).ok, true, 'an omitted named role is an existential variable, not an arity error');
  assert.equal(admitModel(partial, 'Who works?', lex).wires.length, 1);
  const time = '@q query\n  select ?t\n  where match\n    relation "works_at"\n    role subject "Ana"\n    role time ?t\n    polarity affirmed\n  end\n';
  assert.equal(validateQuery({sop: time, message: 'When did Ana work?', lexicon: lex}).ok, true, 'time can be runtime span metadata');
  const fragment = '@q query\n  fragment follow_up\n  where match\n    role object "Lab Alpha"\n  end\n';
  assert.equal(validateQuery({sop: fragment, message: 'And Lab Alpha?', lexicon: lex}).ok, true, 'partial follow-up needs no relation');
});

test('validator: a name of the request that the query leaves out is a problem (it would widen the question)', () => {
  const mentions = [{surface: 'Ana', candidates: ['ana'], strong: true}, {surface: 'Lab Alpha', candidates: ['lab_alpha'], strong: true}, {surface: 'old', candidates: ['old'], strong: false}];
  const full = validateQuery({sop: GOOD, message: 'x', lexicon: lex, mentions});
  assert.equal(full.ok, true, JSON.stringify(full.problems));
  const dropped = validateQuery({sop: '@q query\n  select ?o\n  where match\n    relation "works_at"\n    role subject "Ana"\n    role object ?o\n    polarity affirmed\n  end\n', message: 'x', lexicon: lex, mentions});
  assert.equal(dropped.ok, false);
  assert.deepEqual(dropped.problems.map(p => p.code), ['mention_not_used']);
  assert.match(dropped.problems[0].message, /"Lab Alpha"/);
  const option = validateQuery({sop: '@q query\n  select ?x\n  compare any\n    ?x equal "Ana"\n    ?x equal "Lab Alpha"\n  end\n  where match\n    relation "works_at"\n    role subject ?x\n    role object ?v\n    polarity affirmed\n  end\n', message: 'x', lexicon: lex, mentions});
  assert.equal(option.ok, true, JSON.stringify(option.problems));
});

test('validator, phrase mode (a measured arm): a phrase outside the vocabulary is advice, not a problem', () => {
  const ok = validateQuery({sop: Q('work at', 'Ana', 'Lab Alpha'), message: 'x', lexicon: lex, mode: 'phrase'});
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.advice, []);
  const mismatch = Q('work at', 'Ana', 'Lab Alpha').replace('role object', 'role location');
  assert.deepEqual(validateQuery({sop: mismatch, message: 'x', lexicon: lex, mode: 'phrase'}).problems.map(p => p.code), ['undeclared_role']);
  assert.throws(() => admitModel(mismatch, 'x', lex), /undeclared_role:/);
  const unknown = validateQuery({sop: Q('levitate above', 'Ana', 'Bob'), message: 'x', lexicon: lex, mode: 'phrase'});
  assert.equal(unknown.ok, true);
  assert.ok(unknown.advice.some(a => a.code === 'relation_not_in_vocabulary'));
});

test('at and asof take one point in time: a range is a repairable error, never silently its start (f6-dev-031)', () => {
  const lexicon = new Lexicon('@may_work predicate\n  args subject:entity\n  label en "may work"\n@dorin entity\n  kind entity\n  label en "Dorin"');
  const ranged = '@q query\n  where match\n    relation "may work"\n    role subject "Dorin"\n    polarity affirmed\n  end\n  at "2026-03-01 to 2026-06-01"\n';
  const r = validateQuery({sop: ranged, message: 'May Dorin work throughout 2026-03-01 to 2026-06-01?', lexicon});
  assert.ok(r.problems.some(p => p.code === 'time_not_a_point'), JSON.stringify(r.problems));
  const point = ranged.replace('at "2026-03-01 to 2026-06-01"', 'at "2026-03-01"');
  assert.ok(!validateQuery({sop: point, message: 'May Dorin work on 2026-03-01?', lexicon}).problems.some(p => p.code === 'time_not_a_point'));
  const during = ranged.replace('at "2026-03-01 to 2026-06-01"', 'during "2026-03-01 to 2026-06-01"');
  assert.ok(!validateQuery({sop: during, message: 'May Dorin work throughout 2026-03-01 to 2026-06-01?', lexicon}).problems.some(p => p.code === 'time_not_a_point'));
});

test('a range as a role time value must say throughout (during) or within (overlaps) (f6-dev-086)', () => {
  const lexicon = new Lexicon('@may_work predicate\n  args subject:entity\n  label en "may work"\n@corina entity\n  kind entity\n  label en "Corina"');
  const sop = '@q query\n  where match\n    relation "may work"\n    role subject "Corina"\n    role time "2026-03-01 to 2026-06-01"\n    polarity affirmed\n  end\n';
  const r = validateQuery({sop, message: 'May Corina work throughout 2026-03-01 to 2026-06-01?', lexicon});
  assert.ok(r.problems.some(p => p.code === 'time_range_needs_quantifier'), JSON.stringify(r.problems));
});

test('an undeclared role of a circuit is a validator problem (undeclared_role), never admitted', () => {
  const bad = Q('works_at', 'ana', 'lab_alpha').replace('role object', 'role location');
  const v = validateQuery({sop: bad, message: 'Does Ana work at Lab Alpha?', lexicon: lex});
  assert.equal(v.ok, false);
  assert.ok(v.problems.some(p => p.code === 'undeclared_role'), JSON.stringify(v.problems));
  assert.equal(validateQuery({sop: GOOD, message: 'Does Ana work at Lab Alpha?', lexicon: lex}).ok, true);
});
