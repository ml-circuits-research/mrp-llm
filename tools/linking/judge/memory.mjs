/**
 * The memory the open-vocabulary linking measurements run against: the base memory world-v1 with core-en layered under it
 * (core-min, core-en, then world-v1's own circuits), compiled to one lexicon. Evaluation scaffolding; no product code reads this.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatData, chatDataSettings} from '../../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../../lib/chat-data/memories.mjs';
import {Lexicon} from '../../../sop/lexicon.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = path.join(ROOT, 'config/knowledge/core-en');

/** The lexicon of `base` (default world-v1) with core-en inserted after the imports the base already has. */
export function openVocabularyLexicon({base = 'world-v1', withCore = true} = {}) {
  const memories = new BaseMemories({chatData: new ChatData(chatDataSettings({}))});
  const layered = memories.layeredCircuits(base);
  const core = withCore ? fs.readdirSync(CORE).filter(f => f.endsWith('.sop')).sort().map(f => ({name: `core-en:${f}`, text: fs.readFileSync(path.join(CORE, f), 'utf8')})) : [];
  const alreadyCore = layered.some(c => c.name.startsWith('core-en'));
  const firstOwn = layered.findIndex(c => !c.layer);
  const at = firstOwn < 0 ? layered.length : firstOwn;
  const circuits = alreadyCore || !withCore ? layered : [...layered.slice(0, at), ...core, ...layered.slice(at)];
  return Lexicon.fromCircuits(circuits.map(({name, text}) => ({name, text})), {provenance: `open-vocabulary:${base}${withCore ? '+core-en' : ''}`});
}

/** The vocabulary shown to a judge: predicates with roles, labels and a few forms; compact on purpose. */
export function vocabularyFor(lexicon) {
  return Object.values(lexicon.predicates).map(p => ({
    id: p.id, roles: p.roles.map(r => `${r.name}:${r.type}`), label: p.labels.en ?? null, description: p.description || null,
    forms: [...new Set(p.lexemes.filter(l => l.language === 'en').flatMap(l => l.forms))].slice(0, 6),
  }));
}
