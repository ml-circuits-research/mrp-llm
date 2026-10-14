/** Entity factory: readable ids (no counters), EN/RO labels, grammatical gender and short aliases. */
import { GIVEN_NAMES, SURNAMES, PLACES, ORG_PATTERNS } from './names.mjs';
import { ENTITY_POOLS, ontologyType } from './domains.mjs';
import { foldDiacritics } from './text.mjs';

export const slug = text => foldDiacritics(String(text)).toLowerCase().replace(/^the\s+/, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const ALL_PLACES = [...PLACES.romanian, ...PLACES.romanian, ...PLACES.moldovan, ...PLACES.world];
const TEAM_PATTERN = { en: ['{Place} United', 'the {Place} Wolves', 'CS {Place}', 'Rapid {Place}', 'the {Place} Falcons', 'Olimpia {Place}'], ro: ['{Place} United', 'Lupii din {Place}', 'CS {Place}', 'Rapid {Place}', 'Șoimii din {Place}', 'Olimpia {Place}'] };

/** A per-row entity world; `partition` restricts names/places to a split partition (see splits.mjs). */
/** Plausible fillers of document roles: the goal of `requires` is an application, its prerequisite a supporting paper. */
const ROLE_POOLS = {
  goal: ['a passport', 'a driving licence', 'a work permit', 'a residence certificate', 'a building permit'],
  prerequisite: ['an ID card', 'a birth certificate', 'a medical certificate', 'a criminal record certificate', 'a land title extract'],
};
export class EntityWorld {
  constructor(random, { allowName = () => true, allowPlace = () => true, allowPooled = () => true } = {}) {
    this.allowPooled = allowPooled;
    this.random = random;
    this.allowName = allowName;
    this.allowPlace = allowPlace;
    this.entities = new Map();
    this.firstNames = new Set();
    this.places = new Set();
  }
  add(entity) {
    let id = entity.id;
    if (this.entities.has(id)) id = `${id}_${entity.type}`;
    if (this.entities.has(id)) return null;
    const stored = { ...entity, id };
    this.entities.set(id, stored);
    return stored;
  }
  place() {
    const options = ALL_PLACES.filter(place => this.allowPlace(place) && !this.places.has(place));
    const place = this.random.pick(options.length ? options : ALL_PLACES);
    this.places.add(place);
    return place;
  }
  person({ gender = null, first = null, culture = null } = {}) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const candidates = GIVEN_NAMES.filter(entry => (!gender || entry.gender === gender || entry.gender === 'x') && (!culture || entry.culture === culture) && this.allowName(entry.name));
      const given = first ? GIVEN_NAMES.find(entry => entry.name === first) : this.random.pick(candidates.length ? candidates : GIVEN_NAMES);
      if (!first && this.firstNames.has(given.name)) continue;
      const surnames = SURNAMES[given.culture] ?? SURNAMES.romanian;
      const surname = this.random.pick(surnames);
      const full = `${given.name} ${surname}`;
      if (this.entities.has(slug(full))) continue; // namesakes differ by surname
      const entity = this.add({ id: slug(full), type: 'person', gender: given.gender === 'x' ? (gender ?? this.random.pick(['f', 'm'])) : given.gender, culture: given.culture,
        labels: { en: full, ro: full }, short: given.name, surname });
      if (!entity) continue;
      this.firstNames.add(given.name);
      return entity;
    }
    throw Error('Could not allocate a person');
  }
  organization(kind) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const patterns = kind === 'team' ? TEAM_PATTERN : ORG_PATTERNS[kind];
      const index = this.random.int(patterns.en.length);
      const place = this.place();
      const surname = this.random.pick([...SURNAMES.romanian, ...SURNAMES.hungarian, ...SURNAMES.english, ...SURNAMES.german]);
      const fill = text => text.replaceAll('{Place}', place).replaceAll('{Surname}', surname);
      const labels = { en: fill(patterns.en[index]), ro: fill(patterns.ro[index]) };
      // Two organizations must not share a label in either language, or a mention would be ambiguous by accident.
      if (this.labelTaken(labels)) continue;
      const entity = this.add({ id: slug(labels.en), type: kind, gender: /^(Clinica|Primăria|Școala|Academia|Filarmonica|Sala|Arena|Grădina|Tipografia|Administrația)/.test(labels.ro) ? 'f' : 'm', labels, short: null, place });
      if (entity) return entity;
    }
    throw Error(`Could not allocate a ${kind}`);
  }
  labelTaken(labels) {
    const key = text => foldDiacritics(String(text)).toLowerCase().replace(/^the\s+/, '');
    const wanted = new Set(Object.values(labels).map(key));
    return [...this.entities.values()].some(e => Object.values(e.labels ?? {}).some(label => wanted.has(key(label))));
  }
  city() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const place = this.place();
      const entity = this.add({ id: slug(place), type: 'city', gender: 'n', labels: { en: place, ro: place }, short: null });
      if (entity) return entity;
    }
    throw Error('Could not allocate a city');
  }
  pooled(type, { role = null } = {}) {
    // A role may narrow the pool to plausible fillers (ROLE_POOLS): what a permit requires is a supporting paper.
    const pool = ROLE_POOLS[role] ? ENTITY_POOLS[type].filter(([en]) => ROLE_POOLS[role].includes(en)) : ENTITY_POOLS[type];
    const unused = pool.filter(([en]) => !this.entities.has(slug(en)));
    const allowed = unused.filter(([en]) => this.allowPooled(en));
    const free = allowed.length ? allowed : unused;
    if (!free.length) throw Error(`Pool ${type} exhausted`);
    const [en, ro] = this.random.pick(free);
    // Romanian grammatical gender from the articled head noun ("baza", "aplicația" feminine; "serviciul" masculine/neuter).
    return this.add({ id: slug(en), type, gender: /[aă]$/.test(ro.split(/[\s-]/)[0]) ? 'f' : 'm', labels: { en, ro }, short: null });
  }
  /** Allocate an entity of a generator type (`site` picks an organization subkind). */
  make(type, options = {}) {
    if (type === 'person') return this.person(options);
    if (type === 'city') return this.city();
    if (type === 'site') return this.organization(this.random.pick(['company', 'school', 'clinic', 'office', 'venue']));
    if (['company', 'school', 'clinic', 'office', 'venue', 'team'].includes(type)) return this.organization(type);
    return this.pooled(type, options);
  }
  list() { return [...this.entities.values()]; }
}

/** The surface of an entity in a language; persons are named by first name, full name, or surname with title. */
export function surfaceOf(entity, language, style = 'short') {
  if (style === 'alias' && entity.sharedAlias) return entity.sharedAlias[language];
  if (entity.type !== 'person') return entity.labels[language] ?? entity.labels.en;
  if (style === 'full') return entity.labels[language];
  if (style === 'title') return language === 'ro' ? `${entity.gender === 'f' ? 'doamna' : 'domnul'} ${entity.surname}` : `${entity.gender === 'f' ? 'Ms' : 'Mr'} ${entity.surname}`;
  return entity.short;
}

/** Context/ontology record of an entity for a row language. */
export function entityRecord(entity, language) {
  const aliases = entity.type === 'person' ? [entity.short, entity.surname] : [];
  if (entity.labels.ro !== entity.labels.en) aliases.push(entity.labels[language === 'ro' ? 'en' : 'ro']);
  return { id: entity.id, type: ontologyType(entity.type), label: entity.labels[language] ?? entity.labels.en, aliases: [...new Set(aliases.filter(Boolean))] };
}
