#!/usr/bin/env node
/**
 * Prepare the second-model review of the core-en lexemes: for each area a fenced folder datasets_sources/core-en/review/<area>/
 * with the forms to judge (predicate, roles, description, pos, frame, form, attested in the corpora) and a TASK.md. The reviewer
 * is a model of the other provider than the author; it lists only the forms that are wrong, and `build.mjs` drops those.
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assemble, loadBatches} from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(ROOT, 'datasets_sources/core-en');
const mined = JSON.parse(readFileSync(join(ROOT, 'eval/reports/current/core-en/mined.json'), 'utf8'));
const model = assemble(loadBatches(), {mined});
const task = readFileSync(join(SRC, 'TASK-review.md'), 'utf8');
const byArea = new Map();
for (const p of model.predicates) {
  if (!byArea.has(p.area)) byArea.set(p.area, []);
  byArea.get(p.area).push(p);
}
for (const [area, preds] of byArea) {
  const dir = join(SRC, 'review', area);
  mkdirSync(join(dir, 'input'), {recursive: true});
  mkdirSync(join(dir, 'output'), {recursive: true});
  const lines = ['predicate\troles\tdescription\tlanguage\tpos\tframe\tform\tattested_in_corpora'];
  const attestedSet = new Set(mined.phrases.map(x => x.phrase));
  for (const p of preds) for (const lx of p.lexemes) for (const f of lx.forms) {
    lines.push([p.id, p.roles.map(r => r.join(':')).join(' '), p.description ?? '', lx.language, lx.pos, lx.frame.join(' '), f, attestedSet.has(f) ? 'yes' : 'no'].join('\t'));
  }
  writeFileSync(join(dir, 'input/forms.tsv'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'TASK.md'), task.replaceAll('{{AREA}}', area));
}
console.log('prepared review for', [...byArea.keys()].join(' '));
