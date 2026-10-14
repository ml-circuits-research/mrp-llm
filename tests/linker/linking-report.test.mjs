// The `linking` report of the result packet (DS014 "Result packet"): what the KnowledgeLinker bound from the lexicon of the base memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../../sop/runtime.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {demoLexicon} from '../../lib/knowledge-seeds.mjs';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const MODEL = '@s stated\n  relation "work at"\n  role subject "Maria"\n  role object "Alpha Lab"\n  polarity affirmed\n  certainty asserted\n@q query\n  where match\n    relation "work at"\n    role subject "Maria"\n    role object ?o\n    polarity affirmed\n  end';

test('the packet reports the relation form and the entities it linked', async () => {
  const lexicon = demoLexicon();
  const r = await new Runtime({lexicon, schema: lexicon.predicates, now: NOW}).run('@q query\n  where match\n    relation "work at"\n    role subject "Maria"\n    role object ?o\n    polarity affirmed\n  end', {origin: 'model', inputText: 'Where does Maria work?'});
  const relation = r.result.packet.linking.find(e => e.kind === 'relation'), entity = r.result.packet.linking.find(e => e.kind === 'entity');
  assert.deepEqual([relation.surface, relation.symbol, relation.via, relation.form.kind, relation.form.language], ['work at', 'works_at', 'lexicon', 'lexeme', 'en']);
  assert.deepEqual([entity.surface, entity.symbol, entity.match, entity.class], ['Maria', 'maria', 'exact', 'person']);
});

test('the report names the memory vocabulary that decided: a label of a predicate without lexemes', async () => {
  const lexicon = Lexicon.fromCircuits([{name: 'v', text: '@person entity\n  kind class\n  label en "person"\n@ada entity\n  kind person\n  label en "Ada"\n@knows predicate\n  role subject person\n  role object person\n  label en "knows"\n'}]);
  const r = await new Runtime({lexicon, schema: lexicon.predicates, now: NOW}).run('@q query\n  where match\n    relation "know"\n    role subject "Ada"\n    role object ?o\n    polarity affirmed\n  end', {origin: 'model', inputText: 'Whom does Ada know?'});
  const relation = r.result.packet.linking.find(e => e.kind === 'relation');
  assert.equal(relation.symbol, 'knows');
  assert.equal(relation.form.kind, 'label');
});

test('a mention that does not link is a clarification and is not in the report', async () => {
  const lexicon = demoLexicon();
  const r = await new Runtime({lexicon, schema: lexicon.predicates, now: NOW}).run(MODEL, {origin: 'model', inputText: 'Maria works at Alpha Lab.'});
  assert.ok(Array.isArray(r.result.packet.linking));
  assert.ok(r.result.packet.linking.every(e => e.symbol));
});
