#!/usr/bin/env node
/**
 * Flattens the authored pairs of part 3 (author-part3.json) into questions-part3.json for the labelling judges: for every seed an
 * ambiguous question (intended: the readings the author thinks are plausible) and a clear one (intended: its single reading).
 * The judges never see `intended`; it is kept as the author's independent opinion beside the consensus labels.
 */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from './memory.mjs';

const DIR = path.join(ROOT, 'eval/reports/current/linking/judge');
const data = JSON.parse(fs.readFileSync(path.join(DIR, 'author-part3.json'), 'utf8'));
const questions = [];
for (const a of data.authored) {
  questions.push({i: questions.length, question: a.ambiguous.question.trim(), kind: 'ambiguous', intended: {readings: a.ambiguous.readings ?? [], entity_ambiguity: Boolean(a.ambiguous.entity_ambiguity)}});
  questions.push({i: questions.length, question: a.clear.question.trim(), kind: 'clear', intended: {reading: a.clear.reading}});
}
fs.writeFileSync(path.join(DIR, 'questions-part3.json'), JSON.stringify(questions, null, 1));
console.log(JSON.stringify({questions: questions.length}));
