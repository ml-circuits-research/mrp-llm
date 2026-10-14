#!/usr/bin/env node
/**
 * Prepare the fenced omp task folders of the core-en authoring batches under datasets_sources/core-en/tasks/<area>/.
 * Each folder holds TASK.md, input/ (mined phrases, the area's predicate skeleton, the whole skeleton read-only, the class
 * list, Wikidata property aliases, the archive world, language data) and an empty output/. Run mine.mjs first.
 *
 *   node tools/linking/core-en/prepare-batches.mjs
 */
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(ROOT, 'datasets_sources/core-en');
const mined = JSON.parse(readFileSync(join(ROOT, 'eval/reports/current/core-en/mined.json'), 'utf8'));
const skeleton = readFileSync(join(SRC, 'skeleton.tsv'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
const wd = JSON.parse(readFileSync(join(SRC, 'wikidata-properties.json'), 'utf8')).properties;

export const AREAS = {
  upper: 'The upper ontology and the copula: the 8 predicates of the skeleton, the aliases of the 40 classes, and the ENTITIES of kind occupation (about 110 occupation nouns: the 65 of input/relation-lexicon.json plus world-v1 occupations plus common ones, English and Romanian) and kind property (about 70 attribute adjectives, English and Romanian). For classes write only extra aliases (the class list is fixed).',
  place: 'Places, parts and location: the predicates with area "place". Include transitivity, containment and capital rules as `rules`.',
  people: 'People, kinship, birth and death, residence, citizenship, age, social relations. Include rules: grandparent_of from parent_of twice, ancestor_of transitive, symmetric relations (married_to, sibling_of, friend_of, cousin_of, relative_of, colleague_of, neighbor_of), mother_of and father_of imply parent_of, sibling_of from a shared parent.',
  work: 'Organizations and work: employment, management, membership, sports and music groups, founding, resignation, hiring, salary. Role nouns ("be the boss of", "employer of") are lexemes of pos copula and pos noun.',
  study: 'Study, teaching, events: studies, teaching, attendance, hosting, events, plans and intentions, exams.',
  commerce: 'Possession, commerce, creation, transfer, publication, maintenance: owning, selling, buying, paying, costs, borrowing, renting, sending, publishing, writing, issuing, repairing, growing.',
  move: 'Movement, time, quantity and units: travel, arrival, departure, moving, commuting, event times, durations, deadlines, population, area, distance, measures. Also write ENTITIES of kind unit (second, minute, hour, day, week, month, year, centimetre, metre, kilometre, square kilometre, gram, kilogram, person, cent, leu/RON, euro/EUR, dollar/USD, percent and similar, about 30, English and Romanian, with abbreviations as aliases) and kind currency (about 8), and `rules` for unit_factor facts where they can be written as facts: write them as `facts` ({"predicate":"unit_factor","args":["minute",60]} meaning one minute is 60 base units of seconds), at most 20.',
  health: 'Health, documents, states and outages: allergies, treatment, vaccination, certification, access, eligibility, absence, signing, validity, open/closed states, postponement, outages, causes. The scenario phrases with a fixed object ("get the flu shot", "have access to the lab", "qualify for the bonus") are forms of the zero-extra-role predicates; keep the exact mined string.',
  talk: 'Communication, cognition and need: saying, telling, asking, confirming, calling, reporting, needing, wanting, requiring, depending, checking, inspecting, counting, finding, seeing, choosing, waiting, accepting, rejecting.',
  act: 'General actions and light verbs: taking, bringing, getting, keeping, putting, showing, listing, including, using, replacing, changing, printing, submitting, entering, joining, returning, collecting, covering, washing, marking, booking, staying, running, starting, stopping, finishing, opening, closing, attachment, material.'
};

const common = readFileSync(join(SRC, 'TASK-common.md'), 'utf8');
const phrases = mined.phrases.filter(p => p.count >= 3);
const archiveByForm = new Map();
for (const p of mined.archiveWorld) for (const s of p.en) archiveByForm.set(s, p.id);
const phraseTsv = ['count\tphrase\tmessage roles (most frequent role set)\tarchive world predicate'].concat(phrases.map(p => {
  const roles = Object.entries(p.roleSets).sort((a, b) => b[1] - a[1])[0][0].replaceAll('+', ' ');
  return [p.count, p.phrase, roles, archiveByForm.get(p.phrase) ?? ''].join('\t');
})).join('\n') + '\n';
const wdCompact = Object.entries(wd).map(([pid, p]) => ({pid, label: p.label, aliases: p.aliases, description: p.description.en}));

for (const [area, charter] of Object.entries(AREAS)) {
  const dir = join(SRC, 'tasks', area);
  mkdirSync(join(dir, 'input'), {recursive: true});
  mkdirSync(join(dir, 'output'), {recursive: true});
  const own = skeleton.filter(l => l.startsWith(area + '\t'));
  writeFileSync(join(dir, 'input/skeleton-own.tsv'), 'area\tid\troles\tgloss\n' + own.join('\n') + '\n');
  writeFileSync(join(dir, 'input/skeleton-all.tsv'), 'area\tid\troles\tgloss\n' + skeleton.join('\n') + '\n');
  writeFileSync(join(dir, 'input/mined-phrases.tsv'), phraseTsv);
  writeFileSync(join(dir, 'input/wikidata-properties.json'), JSON.stringify(wdCompact));
  copyFileSync(join(SRC, 'classes.json'), join(dir, 'input/classes.json'));
  copyFileSync(join(ROOT, 'probably_obsolete/tinyLLMExperiments/datasets_archive/formalizer-v1/world/predicates.sop'), join(dir, 'input/archive-world-predicates.sop'));
  if (area === 'upper') {
    copyFileSync(join(ROOT, 'config/relation-lexicon.json'), join(dir, 'input/relation-lexicon.json'));
    writeFileSync(join(dir, 'input/common-nouns.tsv'), 'count\tnoun\n' + mined.commonNouns.map(n => n.count + '\t' + n.noun).join('\n') + '\n');
  }
  writeFileSync(join(dir, 'TASK.md'), common.replaceAll('{{AREA}}', area).replace('{{CHARTER}}', charter).replace('{{OWN_COUNT}}', String(own.length)));
}
console.log('prepared', Object.keys(AREAS).join(' '), 'phrases', phrases.length);
