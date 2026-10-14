// The English-only core (owner decision of 2026-10-01, DS014 "Input languages and content words"): the knowledge holds English only. Since the freeze
// of the small-model branch the translation edges are gone from the product: the coding agent reads the message in any language and writes English
// circuits against the English vocabulary of the memory; an answer is rendered in English.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SEEDS_DIR, seedIds} from '../../lib/knowledge-seeds.mjs';
import {validateProgram} from '../../sop/knowledge/index.mjs';
import {Dictionary, englishDictionary} from '../../sop/dictionary.mjs';
import {repoPath} from '../helpers.mjs';

test('knowledge: the validator rejects any language but English in lexemes, labels and aliases', () => {
  const ok = '@person entity\n  kind class\n  label en "person"\n@works_at predicate\n  args subject:entity object:entity\n  role subject person\n  role object person\n  label en "works at"\n@lx_en lexeme\n  of works_at\n  language en\n  form "work at"\n  frame subject object\n';
  assert.deepEqual(validateProgram([{name: 'ok.sop', text: ok}]).problems.filter(p => p.severity !== 'warning').map(p => p.code), []);
  for (const [name, text] of [
    ['lexeme', ok + '@lx_ro lexeme\n  of works_at\n  language ro\n  form "lucra la"\n  frame subject object\n'],
    ['label', ok.replace('label en "person"', 'label en "person"\n  label ro "persoană"')],
    ['alias', ok.replace('label en "person"', 'label en "person"\n  alias ro "om"')],
  ]) assert.ok(validateProgram([{name: 'bad.sop', text}]).problems.some(p => p.code === 'non_english_knowledge'), name);
});

test('knowledge: the shipped seed memories and the world builders hold no Romanian label, alias or lexeme', () => {
  for (const id of seedIds()) for (const file of fs.readdirSync(path.join(SEEDS_DIR, id)).filter(n => n.endsWith('.sop'))) {
    const bad = fs.readFileSync(path.join(SEEDS_DIR, id, file), 'utf8').split('\n').filter(line => /^\s+(language|label|alias) (?!en\b)[a-z]{2,3}\b/.test(line));
    assert.deepEqual(bad, [], `${id}/${file}`);
  }
  for (const builder of ['tools/linking/core-en/build.mjs', 'tools/world-kb/build.mjs', 'tools/world-kb/mapping.mjs']) {
    assert.doesNotMatch(fs.readFileSync(repoPath(builder), 'utf8'), /label ro |alias ro |language ro|ro: \[|\bro: '/, builder);
  }
});

test('linker: the product dictionary view carries English synonyms only and never translates', () => {
  const view = englishDictionary();
  assert.deepEqual(view.candidates('lucra la', 'relation'), {status: 'unchanged', candidates: ['lucra la'], untranslated: [], sources: []});
  assert.ok(view.synonyms('work at', 'relation').includes('be employed by'));
  assert.ok(view.entries.every(entry => entry.ro.length === 0 && entry.forms.length === 0));
  const full = Dictionary.fromEntries([{id: 'rel:x', pos: 'relation', en: ['work at'], ro: ['lucra la'], forms: []}]);
  assert.equal(full.candidates('lucra la', 'relation').status, 'translated', 'the full dictionary stays for the edges and the evaluation');
});
