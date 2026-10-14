/** Canonical English targets (DS014, owner decision Q-DATA-6 of 2026-09-28).
 *
 * The reasoner's knowledge is English. The formalizer accepts English, Romanian and mixed messages, but its SOP
 * output is always canonical English, written as if the message had been English:
 *   - relation phrases are English: a Romanian construction carries the English phrase of its meaning
 *     (`RO_CONSTRUCTION_EN`, keyed by construction id), and authored Romanian phrases of custom families are
 *     translated by `RO_RELATION_EN`;
 *   - common-noun values (the pooled entities of domains.mjs ENTITY_POOLS: courses, products, foods, documents,
 *     transport, payment, plants, choirs, assets, …) are written with their English label;
 *   - proper names of persons, organizations and places stay exactly as written, diacritics included;
 *   - dates are written in English ("12 martie 2020" → "12 March 2020");
 *   - `unclear` readings are English.
 * This module is the generator's EN↔RO lexicon; the corpus audit reads the same pairs (`translationPairs`) to
 * check that a translated `stated` value comes from the message.
 */
import { ENTITY_POOLS, PREDICATES } from './domains.mjs';
import { MONTHS } from './frames.mjs';

/** English relation phrase of every Romanian construction (`<predicate>.ro.<index>`). */
export const RO_CONSTRUCTION_EN = Object.freeze({
  'works_at.ro.0': 'work at', 'works_at.ro.1': 'be employed by', 'works_at.ro.2': 'work at', 'works_at.ro.3': 'have a job at',
  'manages.ro.0': 'manage', 'manages.ro.1': 'report to', 'manages.ro.2': 'be the boss of',
  'parent_of.ro.0': 'be a parent of', 'parent_of.ro.1': 'be a child of', 'parent_of.ro.2': 'raise',
  'married_to.ro.0': 'be married to',
  'studies_at.ro.0': 'study at', 'studies_at.ro.1': 'be enrolled at', 'studies_at.ro.2': 'attend classes at',
  'teaches.ro.0': 'teach', 'teaches.ro.1': 'give classes in', 'teaches.ro.2': 'give lessons in',
  'treats.ro.0': 'treat', 'treats.ro.1': 'be the doctor of', 'treats.ro.2': 'be treated by',
  'allergic_to.ro.0': 'be allergic to', 'allergic_to.ro.1': 'have an allergy to', 'allergic_to.ro.2': 'be allergic to',
  'lives_in.ro.0': 'live in', 'lives_in.ro.1': 'live in', 'lives_in.ro.2': 'live in',
  'owns.ro.0': 'own',
  'sells.ro.0': 'sell', 'sells.ro.1': 'have for sale', 'sells.ro.2': 'sell',
  'supplies.ro.0': 'supply', 'supplies.ro.1': 'buy from',
  'attended.ro.0': 'take part in', 'attended.ro.1': 'attend', 'attended.ro.2': 'be present at',
  'held_at.ro.0': 'take place at', 'held_at.ro.1': 'host',
  'wrote.ro.0': 'write', 'wrote.ro.1': 'be the author of',
  'published.ro.0': 'publish',
  'borrowed.ro.0': 'borrow',
  'plays_for.ro.0': 'play for', 'plays_for.ro.1': 'be on',
  'coaches.ro.0': 'coach', 'coaches.ro.1': 'be the coach of', 'coaches.ro.2': 'train',
  'maintains.ro.0': 'maintain', 'maintains.ro.1': 'be responsible for', 'maintains.ro.2': 'look after', 'maintains.ro.3': 'take care of',
  'depends_on.ro.0': 'depend on', 'depends_on.ro.1': 'rely on',
  'issued.ro.0': 'issue', 'issued.ro.1': 'be issued by',
  'requires.ro.0': 'require', 'requires.ro.1': 'require',
  'located_in.ro.0': 'be located in', 'located_in.ro.1': 'be in', 'located_in.ro.2': 'be based in',
  'travelled_to.ro.0': 'travel to', 'travelled_to.ro.1': 'visit', 'travelled_to.ro.2': 'leave for',
  'commutes_by.ro.0': 'commute by', 'commutes_by.ro.1': 'go to work by',
  'pays_with.ro.0': 'pay with', 'pays_with.ro.1': 'pay with',
  'cooks_at.ro.0': 'cook at', 'cooks_at.ro.1': 'be the chef at',
  'repairs.ro.0': 'repair', 'repairs.ro.1': 'work on',
  'grows.ro.0': 'grow', 'grows.ro.1': 'plant',
  'sings_in.ro.0': 'sing in', 'sings_in.ro.1': 'be a member of',
  'rents.ro.0': 'rent',
  'open_now.ro.0': 'be open',
  'available.ro.0': 'be free', 'available.ro.1': 'be available',
  'certified.ro.0': 'be certified', 'certified.ro.1': 'have a valid certificate',
  'trained.ro.0': 'complete the safety training', 'trained.ro.1': 'be trained',
  'authorized.ro.0': 'have access to the lab',
  'eligible.ro.0': 'be eligible for the bonus', 'eligible.ro.1': 'get the bonus',
  'vaccinated.ro.0': 'get the flu shot', 'vaccinated.ro.1': 'be vaccinated',
  'absent.ro.0': 'be absent from work',
  'ill.ro.0': 'be ill', 'ill.ro.1': 'have the flu',
  'down.ro.0': 'be down', 'down.ro.1': 'go down',
  'overloaded.ro.0': 'be overloaded',
  'caused_outage.ro.0': 'go down because of problems with', 'caused_outage.ro.1': 'go down because of',
  'wants_to_move.ro.0': 'want to move to',
  'plans_to_leave.ro.0': 'want to leave',
  'sick_from.ro.0': 'get sick from',
  'closed_for.ro.0': 'be closed for',
  'delayed_by.ro.0': 'be postponed because of problems with',
  'quit_over.ro.0': 'quit because of conflicts with', 'quit_over.ro.1': 'quit because of',
  'closed_today.ro.0': 'be closed',
  'postponed.ro.0': 'be postponed',
  'resigned.ro.0': 'resign', 'resigned.ro.1': 'hand in notice',
  'wants_to_learn.ro.0': 'want to learn',
  'plans_to_attend.ro.0': 'want to go to', 'plans_to_attend.ro.1': 'plan to attend',
  // Authored-only predicates of the expansion families.
  'costs.ro.0': 'cost', 'aged.ro.0': 'be old', 'opens_at.ro.0': 'open at', 'sent_to.ro.0': 'send', 'moved.ro.0': 'move', 'bought_together.ro.0': 'buy together',
  'means.ro.0': 'mean', 'may_sign.ro.0': 'be allowed to sign', 'should_accept.ro.0': 'should accept the offer from',
});

/**
 * English phrases of the Romanian relation phrases authored directly by custom families (families*.mjs), and of
 * every Romanian construction phrase whose meaning is unambiguous. `englishRelation` throws on a Romanian phrase
 * missing here, so no Romanian phrase can reach a target unnoticed.
 */
export const RO_RELATION_EN = Object.freeze({
  'lucra la': 'work at', 'fi angajat la': 'be employed by', 'munci la': 'work at', 'coordona': 'manage', 'raporta către': 'report to', 'fi șeful lui': 'be the boss of',
  'fi părintele lui': 'be a parent of', 'fi copilul lui': 'be a child of', 'crește': 'raise', 'fi căsătorit cu': 'be married to', 'învăța la': 'study at', 'fi înscris la': 'be enrolled at',
  'preda': 'teach', 'ține ore de': 'give classes in', 'trata': 'treat', 'fi medicul lui': 'be the doctor of', 'se trata la': 'be treated by', 'fi alergic la': 'be allergic to',
  'avea alergie la': 'have an allergy to', 'face alergie la': 'be allergic to', 'locui în': 'live in', 'sta în': 'live in', 'deține': 'own', 'vinde': 'sell', 'avea de vânzare': 'have for sale',
  'aproviziona': 'supply', 'cumpăra de la': 'buy from', 'participa la': 'take part in', 'merge la': 'attend', 'avea loc la': 'take place at', 'găzdui': 'host', 'scrie': 'write',
  'fi autorul': 'be the author of', 'publica': 'publish', 'împrumuta': 'borrow', 'juca la': 'play for', 'fi în lotul': 'be on', 'antrena': 'coach', 'fi antrenorul': 'be the coach of',
  'întreține': 'maintain', 'răspunde de': 'be responsible for', 'se ocupa de': 'look after', 'depinde de': 'depend on', 'se baza pe': 'rely on', 'elibera': 'issue', 'se elibera la': 'be issued by',
  'necesita': 'require', 'cere': 'require', 'se afla în': 'be located in', 'fi în': 'be in', 'avea sediul în': 'be based in', 'călători la': 'travel to', 'vizita': 'visit',
  'face naveta cu': 'commute by', 'merge la serviciu cu': 'go to work by', 'plăti cu': 'pay with', 'achita cu': 'pay with', 'găti la': 'cook at', 'fi bucătar la': 'be the chef at',
  'repara': 'repair', 'cultiva': 'grow', 'planta': 'plant', 'cânta în': 'sing in', 'fi membru în': 'be a member of', 'închiria': 'rent', 'fi deschis': 'be open', 'fi liber': 'be free',
  'fi disponibil': 'be available', 'fi certificat': 'be certified', 'avea certificat valabil': 'have a valid certificate', 'termina instruirea de siguranță': 'complete the safety training',
  'fi instruit': 'be trained', 'avea acces în laborator': 'have access to the lab', 'fi eligibil pentru bonus': 'be eligible for the bonus', 'lua bonusul': 'get the bonus',
  'se vaccina antigripal': 'get the flu shot', 'fi vaccinat': 'be vaccinated', 'lipsi de la serviciu': 'be absent from work', 'fi bolnav': 'be ill', 'avea gripă': 'have the flu',
  'fi căzut': 'be down', 'pica': 'go down', 'fi supraîncărcat': 'be overloaded', 'cădea din cauza problemelor cu': 'go down because of problems with', 'cădea din cauza': 'go down because of',
  'vrea să se mute în': 'want to move to', 'vrea să plece de la': 'want to leave', 'se îmbolnăvi de la': 'get sick from', 'fi închis pentru': 'be closed for',
  'fi amânat din cauza problemelor cu': 'be postponed because of problems with', 'demisiona din cauza conflictelor cu': 'quit because of conflicts with', 'demisiona din cauza': 'quit because of',
  'fi închis': 'be closed', 'fi amânat': 'be postponed', 'demisiona': 'resign', 'da demisia': 'hand in notice', 'vrea să învețe': 'want to learn', 'vrea să meargă la': 'want to go to',
  'plănui să participe la': 'plan to attend',
  'costa': 'cost', 'avea ani': 'be old', 'se deschide la': 'open at', 'trimite': 'send', 'se muta': 'move', 'cumpăra împreună': 'buy together',
  'avea voie să semneze': 'be allowed to sign', 'ar trebui să accepte oferta de la': 'should accept the offer from',
  // Sense aliases (the bare or light-verb phrases of the word-sense cases, domains.mjs senseAliases).
  'face naveta': 'commute', 'ajunge la serviciu': 'get to work', 'merge la serviciu': 'go to work', 'plăti': 'pay', 'achita': 'pay', 'fi jucător la': 'be a player of',
  'fi elev la': 'be a student at', 'fi participant la': 'be at', 'face': 'make', 'avea': 'have', 'fi salariat la': 'be an employee of', 'fi angajatul': 'be an employee of',
  // Interpretation and meta phrases of custom families.
  'se referi la': 'refer to', 'însemna': 'mean',
});

/** The English phrase of a relation phrase realized in `language`. Throws on an untranslated Romanian phrase. */
export function englishRelation(relation, language) {
  if (language === 'en') return relation;
  const english = RO_RELATION_EN[relation];
  if (english) return english;
  if (ENGLISH_PHRASES.has(relation)) return relation;
  throw Error(`no English relation phrase for ${language} "${relation}" (tools/datasets/diversity/english.mjs)`);
}
// English phrases that are safe to meet in a Romanian realization (already translated).
const ENGLISH_PHRASES = new Set([...Object.values(RO_CONSTRUCTION_EN), ...Object.values(RO_RELATION_EN),
  ...Object.values(PREDICATES).flatMap(spec => [...spec.en.map(c => c.rel), ...(spec.senseAliases?.en ?? [])])]);

/** Pooled entity types: common nouns whose English label is the target value. Other types are proper names. */
export const COMMON_NOUN_TYPES = Object.freeze(new Set(Object.keys(ENTITY_POOLS)));
/** The target value of an entity mentioned in `language` with surface `text`. */
export function targetValue(entity, text, language) {
  if (language === 'en' || !entity) return text;
  // A deliberately ambiguous shared mention ("turneul de șah" for one of several chess tournaments) stays ambiguous
  // in English ("the chess tournament"); a specific common noun takes its English label.
  if (entity.sharedAlias && text === entity.sharedAlias[language]) return COMMON_NOUN_TYPES.has(entity.type) ? entity.sharedAlias.en ?? text : text;
  // A conjoined group name ("Ana și Ion" → "Ana and Ion") is written in English like a common noun.
  if (entity.translateLabel) return entity.labels.en;
  return COMMON_NOUN_TYPES.has(entity.type) ? entity.labels.en : text;
}

/** A date written in English (day month year), whatever the message language. */
export function englishDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS.en[m - 1]} ${y}`;
}

const KINSHIP = [['brother', 'frate', 'fratele'], ['sister', 'soră', 'sora'], ['mother', 'mamă', 'mama'], ['father', 'tată', 'tatăl', 'tata'], ['wife', 'soție', 'soția'], ['husband', 'soț', 'soțul'],
  ['son', 'fiu', 'fiul'], ['daughter', 'fiică', 'fiica'], ['neighbour', 'vecin', 'vecinul', 'vecina'], ['colleague', 'coleg', 'colegul', 'colega'], ['boss', 'șef', 'șeful', 'șefa'], ['friend', 'prieten', 'prietenul', 'prietena']];
/** EN↔RO pairs of the generator's lexicon (common-noun labels and month names), for cross-lingual anchoring. */
export function translationPairs() {
  const pairs = Object.values(ENTITY_POOLS).flatMap(pool => pool.map(([en, ro]) => [en, ro]));
  MONTHS.en.forEach((month, i) => pairs.push([month, MONTHS.ro[i]]));
  // Kinship and relation nouns of first-person values ("the user's brother" for "fratele meu", Q-LANG-5).
  for (const [en, ...ro] of KINSHIP) for (const form of ro) pairs.push([en, form]);
  return pairs;
}
