/**
 * The world-v1 mapping table: one row per Wikidata property (and per derived form of one), the single source of
 * both the fetch plan (fetch.mjs) and the wire emitter (build.mjs). `node tools/world-kb/mapping-table.mjs` renders it as MAPPING.md.
 *
 *   scope   entity classes (keys of CLASSES) whose members the property is read for
 *   pid     Wikidata property
 *   pred    predicate name in the base memory
 *   kind    entity   value is an item (symbol; the item gets labels)
 *           year     value is a time; precision >= year; integer year (negative for BCE)
 *           date     value is a time with day precision; emitted as a `time` term (years 1..9999 only)
 *           integer  value is a quantity, rounded to an integer
 *           text     value is a string
 *   roles   the predicate's `args`
 *   only    entity values restricted to this set of Wikidata items (a curated list), else any item
 */
export const CLASSES = {
  country: {qid: 'Q3624078', label: 'sovereign state', min: null},
  continent: {qid: 'Q5107', label: 'continent'},
  city: {qid: 'Q515', label: 'city'},
  language: {qid: 'Q34770', label: 'language'},
  currency: {qid: 'Q8142', label: 'currency'},
  element: {qid: 'Q11344', label: 'chemical element'},
  planet: {qid: 'Q634', label: 'planet'},
  person: {qid: 'Q5', label: 'human'},
  company: {qid: 'Q4830453', label: 'business'},
  university: {qid: 'Q3918', label: 'university'},
  organization: {qid: 'Q484652', label: 'international organization'},
  literary_work: {qid: 'Q7725634', label: 'literary work'},
  film: {qid: 'Q11424', label: 'film'},
  painting: {qid: 'Q3305213', label: 'painting'},
};

export const PEOPLE_OCCUPATIONS = {
  physicist: 'Q169470', chemist: 'Q593644', mathematician: 'Q170790', biologist: 'Q864503', astronomer: 'Q11063',
  philosopher: 'Q4964182', economist: 'Q188094', engineer: 'Q81096', inventor: 'Q205375', physician: 'Q39631', computer_scientist: 'Q82594',
  writer: 'Q36180', poet: 'Q49757', novelist: 'Q6625963', playwright: 'Q214917', painter: 'Q1028181', sculptor: 'Q1281618',
  architect: 'Q42973', composer: 'Q36834', explorer: 'Q11900058', politician: 'Q82955', monarch: 'Q116', military_leader: 'Q47064',
  film_director: 'Q2526255', actor: 'Q33999', singer: 'Q177220', theologian: 'Q1234713', historian: 'Q201788',
};

export const AWARDS = {
  q38104: 'Q38104', q44585: 'Q44585', q80061: 'Q80061', q37922: 'Q37922', q35637: 'Q35637', q47170: 'Q47170', q28835: 'Q28835', q185667: 'Q185667',
};
export const ORG_MEMBERSHIPS = ['Q1065', 'Q458', 'Q7184', 'Q7159', 'Q7768', 'Q19771', 'Q7172', 'Q7795']; // UN, EU, NATO, African Union, ASEAN, G20, Arab League, OPEC (labels verified at fetch time)

const R = (...pairs) => pairs.map(p => p.split(':'));
const SO = R('subject:entity', 'object:entity');
const SL = R('subject:entity', 'location:entity');
const SY = R('subject:entity', 'object:integer');   // entity, integer value (Wikidata direction)
const SYr = R('subject:integer', 'object:entity');  // integer value first (flipped: "the population of X")
const ST = R('subject:entity', 'object:text');
const STr = R('subject:text', 'object:entity');
const STIME = R('subject:entity', 'time:time');
/**
 * Orientation rule: a predicate reads as the English sentence the question patterns of SymbolicLM produce
 * ("Paris is the capital of France" is `capital_of paris france`), so a Wikidata statement whose natural reading runs the
 * other way is emitted flipped (`flip: true`: subject and value swap places). `aliases` are the relation phrases of the
 * lexicon (English only) that link a question to the predicate; the role names are the closed role inventory.
 */
const row = (scope, pid, pred, kind, roles, extra = {}) => ({scope, pid, pred, kind, roles, ...extra});

export const MAPPING = [
  row(['country'], 'P36', 'capital_of', 'entity', SO, {flip: true, aliases: {en: ['be the capital of', 'capital of']}, note: 'capital of the country (current); flipped'}),
  row(['country'], 'P30', 'located_in', 'entity', SL, {note: 'continent; merged into located_in so that "which continent is X in" links'}),
  row(['country'], 'P37', 'official_language_of', 'entity', SO, {flip: true, aliases: {en: ['be the official language of']}, note: 'flipped'}),
  row(['country'], 'P38', 'uses_currency', 'entity', SO, {aliases: {en: ['use', 'use as currency', 'have the currency']}}),
  row(['country'], 'P35', 'head_of_state_of', 'entity', SO, {flip: true, aliases: {en: ['be the head of state of']}, note: 'current holder, best rank; flipped'}),
  row(['country'], 'P6', 'head_of_government_of', 'entity', SO, {flip: true, aliases: {en: ['be the head of government of']}, note: 'current holder, best rank; flipped'}),
  row(['country'], 'P47', 'borders', 'entity', SO, {objectClass: 'country', aliases: {en: ['border', 'share a border with']}, note: 'shares a land border, between selected countries only: a constituent country (Q35 Denmark next to Q756617 Kingdom of Denmark) would count one border twice; Wikidata states both directions'}),
  row(['country'], 'P463', 'member_of', 'entity', SO, {only: ORG_MEMBERSHIPS, aliases: {en: ['be a member of', 'belong to']}, note: 'membership in a curated list of international organizations'}),
  row(['country', 'city', 'language', 'currency'], 'P1082', 'population_of', 'integer', SY, {aliases: {en: ['be the population of']}, note: 'best-rank value; core-en orientation (entity, number)'}),
  row(['country'], 'P2046', 'area_of', 'integer', SY, {aliases: {en: ['be the area of']}, note: 'square kilometres, rounded (core-en: unit km2)'}),
  row(['country', 'company', 'university', 'organization', 'city'], 'P571', 'founded_year', 'year', STIME, {aliases: {en: ['be founded', 'be established']}, note: 'inception; year precision'}),
  row(['country'], 'P297', 'iso_country_code', 'text', ST, {aliases: {en: ['have the country code']}, note: 'ISO 3166-1 alpha-2'}),
  row(['language'], 'P218', 'iso_language_code', 'text', ST, {aliases: {en: ['have the language code']}, note: 'ISO 639-1'}),
  row(['currency'], 'P498', 'iso_currency_code', 'text', ST, {aliases: {en: ['have the currency code']}, note: 'ISO 4217'}),
  row(['language'], 'P279', 'language_family', 'entity', SO, {aliases: {en: ['belong to the language family']}, note: 'subclass of: the family or parent language'}),
  row(['country', 'city', 'company', 'university', 'organization', 'literary_work', 'film', 'painting'], 'P17', 'located_in', 'entity', SL, {aliases: {en: ['be located in', 'be in', 'be situated in', 'lie in']}, note: 'country; merged with P131 and P30 under one predicate (rule r_located_trans)'}),
  row(['city', 'company', 'university', 'organization'], 'P131', 'located_in', 'entity', SL, {note: 'located in the administrative territorial entity'}),
  row(['person'], 'P569', 'born_on', 'year', STIME, {note: 'year of birth; the predicate and its lexemes are core-en\'s'}),
  row(['person'], 'P569', 'birthday', 'date', R('subject:entity', 'time:text'), {note: 'ISO 8601 text, only when the date has day precision'}),
  row(['person'], 'P570', 'died_on', 'year', STIME, {note: 'year of death; the predicate and its lexemes are core-en\'s'}),
  row(['person'], 'P570', 'deathday', 'date', R('subject:entity', 'time:text'), {note: 'ISO 8601 text, only when the date has day precision'}),
  row(['person'], 'P19', 'born_in', 'entity', SL, {aliases: {en: ['be born in']}}),
  row(['person'], 'P20', 'died_in', 'entity', SL, {aliases: {en: ['die in']}}),
  row(['person'], 'P27', 'citizen_of', 'entity', SO, {aliases: {en: ['be a citizen of', 'have citizenship of']}}),
  row(['person'], 'P106', 'has_occupation', 'entity', SO, {aliases: {en: ['work as', 'have the occupation']}}),
  row(['person'], 'P21', 'gender', 'entity', SO, {aliases: {en: ['have the gender']}}),
  row(['person'], 'P69', 'studies_at', 'entity', SO, {note: 'educated at; the predicate and its lexemes are core-en\'s'}),
  row(['person'], 'P166', 'receives', 'entity', SO, {only: Object.values(AWARDS), note: 'award received; curated list: the Nobel Prizes, Fields Medal, Turing Award; the predicate and its lexemes are core-en\'s'}),
  row(['company', 'university', 'organization'], 'P159', 'headquartered_in', 'entity', SL, {aliases: {en: ['be headquartered in', 'have its headquarters in']}}),
  row(['company', 'organization'], 'P112', 'founded', 'entity', SO, {flip: true, aliases: {en: ['establish']}, note: 'founded by; flipped'}),
  row(['company'], 'P452', 'industry', 'entity', SO, {aliases: {en: ['operate in the industry of']}}),
  row(['company', 'university'], 'P749', 'subsidiary_of', 'entity', SO, {note: 'parent organization; the predicate and its lexemes are core-en\'s'}),
  row(['literary_work'], 'P50', 'writes', 'entity', SO, {flip: true, note: 'author; flipped; the predicate and its lexemes are core-en\'s'}),
  row(['film'], 'P57', 'directed', 'entity', SO, {flip: true, aliases: {en: ['direct']}, weight: 6, note: 'director; flipped; "direct" is shared with core-en head_of (weight 10, organization): the entities of the message tell them apart'}),
  row(['painting'], 'P170', 'painted', 'entity', SO, {flip: true, aliases: {en: ['paint', 'create']}, note: 'creator of a painting; flipped'}),
  row(['literary_work', 'film'], 'P577', 'publication_year', 'year', STIME, {aliases: {en: ['be published', 'be released']}, note: 'publication or release year'}),
  row(['painting'], 'P571', 'publication_year', 'year', STIME, {note: 'inception of the painting'}),
  row(['literary_work'], 'P407', 'language_of_work', 'entity', SO, {aliases: {en: ['be written in']}, note: 'P407 for literary works, P364 for films (original language)'}),
  row(['film'], 'P364', 'language_of_work', 'entity', SO),
  row(['literary_work', 'film'], 'P495', 'origin_country', 'entity', SO, {aliases: {en: ['come from', 'originate in']}}),
  row(['element'], 'P1086', 'atomic_number_of', 'integer', SYr, {flip: true, aliases: {en: ['be the atomic number of']}, note: 'flipped'}),
  row(['element'], 'P246', 'symbol_of', 'text', STr, {flip: true, aliases: {en: ['be the chemical symbol of', 'be the symbol of']}, note: 'flipped'}),
  row(['element'], 'P575', 'discovery_year', 'year', STIME, {aliases: {en: ['be discovered']}}),
  row(['element'], 'P61', 'finds', 'entity', SO, {flip: true, note: 'discoverer; flipped; the predicate and its lexemes (find, discover) are core-en\'s'}),
  row(['planet'], 'P397', 'orbits', 'entity', SO, {aliases: {en: ['orbit', 'revolve around']}, note: 'parent astronomical body'}),
  row(['planet'], 'P575', 'discovery_year', 'year', STIME),
  row(['planet'], 'P61', 'finds', 'entity', SO, {flip: true}),
];

/** Predicates that are not one Wikidata property: class membership and descriptions, emitted for every selected entity. Labels and the number of Wikipedia editions (notability) are not facts: they are the `label` and `notability` lines of the entity wire. */
export const DERIVED = [
  {pred: 'is_a', source: 'P31', roles: SO, note: 'instance of: only the curated classes of CLASSES (country, city, human, ...), plus the selection class'},
  {pred: 'description', source: 'description', roles: ST, note: 'English description (schema:description@en) of selected entities; the entity wire uses it to tell namesakes apart'},
];

/**
 * The classes world-v1 declares on top of core-min (which owns class, entity, person, organization, place, occupation, property, unit):
 * the entity wire of each (English label, aliases including the plural, Romanian label) and its parent class, stated as an `is_a` fact.
 * Selected entities are kind-typed with their selection class; `person` and `organization` are core-min classes.
 */
export const CLASS_VOCAB = {
  country: {en: 'country', alias: ['countries', 'nation', 'nations', 'sovereign state'], parent: 'place'},
  continent: {en: 'continent', alias: ['continents'], parent: 'place'},
  city: {en: 'city', alias: ['cities', 'town'], parent: 'place'},
  language: {en: 'language', alias: ['languages', 'tongue'], parent: 'entity'},
  currency: {en: 'currency', alias: ['currencies', 'money'], parent: 'unit'},
  element: {en: 'chemical element', alias: ['element', 'elements', 'chemical elements'], parent: 'entity'},
  planet: {en: 'planet', alias: ['planets'], parent: 'entity'},
  company: {en: 'company', alias: ['companies', 'business', 'firm', 'corporation'], parent: 'organization'},
  university: {en: 'university', alias: ['universities'], parent: 'organization'},
  literary_work: {en: 'literary work', alias: ['work', 'book', 'novel', 'books', 'literary works'], parent: 'creative_work'},
  film: {en: 'film', alias: ['movie', 'films', 'movies'], parent: 'creative_work'},
  painting: {en: 'painting', alias: ['paintings', 'artwork'], parent: 'creative_work'},
};

/**
 * The class of the VALUES of an entity-valued property, for the items that are not themselves selected (a capital that is no
 * selected city, a birthplace, a doctoral place): they are typed with it, so the role classes of the predicates (core-en says
 * `capital_of` takes a city and a country) accept them. A selected item keeps its selection class; when an item is the value of properties with different ranges,
 * the most frequent range wins (kindFromRanges) and CLASS_PRIORITY breaks ties.
 */
export const RANGE = {
  P36: 'city', P30: 'continent', P37: 'language', P38: 'currency', P35: 'person', P6: 'person', P47: 'country', P463: 'organization',
  P279: 'language', P17: 'country', P131: 'place', P19: 'place', P20: 'place', P27: 'country', P69: 'organization', P159: 'place',
  P112: 'person', P749: 'organization', P50: 'person', P57: 'person', P170: 'person', P407: 'language', P364: 'language', P495: 'country', P61: 'person',
};
export const CLASS_PRIORITY = ['person', 'country', 'city', 'continent', 'language', 'currency', 'organization', 'place'];
/**
 * The class of an unselected item from the ranges of the properties it is the value of: the most frequent range wins and
 * CLASS_PRIORITY only breaks ties. One "founded by" (P112, range person) must not make Denmark, the value of 32 country and
 * place properties, a person.
 */
export function kindFromRanges(counts) {
  const entries = [...(counts ?? new Map())].filter(([c]) => CLASS_PRIORITY.includes(c));
  if (!entries.length) return undefined;
  entries.sort(([a, x], [b, y]) => y - x || CLASS_PRIORITY.indexOf(a) - CLASS_PRIORITY.indexOf(b));
  return entries[0][0];
}
