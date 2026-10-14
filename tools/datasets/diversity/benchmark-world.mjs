import fs from 'node:fs';
import path from 'node:path';

const circuits = root => path.join(root, 'base_memories', 'world-v1', 'circuits');
const relations = ['born-in', 'located-in', 'capital-of', 'is-a', 'population-of'];
function readRelation(files, root, id) {
  const rows = [];
  for (const file of files.filter(x => x.includes(`facts-${id}-`))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, a, b] of source.matchAll(/^  holds [^ ]+ ([^ ]+) ([^ ]+)$/gm)) rows.push([a, b]);
  }
  return rows;
}
/** The world facts are an on-disk approved base memory, not an invented F1 surrogate. */
export async function worldMultihop({split = 'dev'} = {}) {
  if (!['dev', 'preview'].includes(split)) throw new Error('World generator cannot read sealed data');
  const {defaultRoot} = await import('../../eval/lib/session.mjs');
  const root = circuits(defaultRoot());
  if (!fs.existsSync(root)) throw new Error(`world-v1 prerequisite missing: ${root}`);
  const worldFacts = JSON.parse(fs.readFileSync(path.join(path.dirname(root), 'manifest.json'), 'utf8')).facts;
  if (!Number.isSafeInteger(worldFacts) || worldFacts < 100000) throw new Error('world-v1 source is not a large approved KB');
  const files = fs.readdirSync(root), edges = Object.fromEntries(relations.map(id => [id, readRelation(files, root, id)]));
  const countries = new Set(edges['is-a'].filter(([, type]) => type === 'country').map(([entity]) => entity));
  const capitals = new Map();
  for (const [city, country] of edges['capital-of']) if (countries.has(country)) {
    if (!capitals.has(country)) capitals.set(country, new Set());
    capitals.get(country).add(city);
  }
  const populations = new Map();
  for (const [entity, value] of edges['population-of']) {
    if (!populations.has(entity)) populations.set(entity, new Set());
    populations.get(entity).add(Number(value));
  }
  const locations = new Map();
  for (const [city, country] of edges['located-in']) if (capitals.has(country)) {
    if (!locations.has(city)) locations.set(city, new Set());
    locations.get(city).add(country);
  }
  const people = new Map();
  for (const [person, birthplace] of edges['born-in']) {
    for (const country of locations.get(birthplace) ?? []) {
      if (!people.has(person)) people.set(person, {places: new Set(), countries: new Set(), capitals: new Set()});
      const row = people.get(person);
      row.places.add(birthplace); row.countries.add(country);
      for (const capital of capitals.get(country)) row.capitals.add(capital);
    }
  }
  // Split by person identity, never by question text; no sealed file is accessed.
  const eligible = [...people].filter(([, row]) => row.capitals.size === 1 && row.countries.size === 1 && row.places.size === 1 && populations.get([...row.capitals][0])?.size === 1).sort(([a], [b]) => a.localeCompare(b));
  const partition = eligible.filter((_, i) => i % 2 === (split === 'dev' ? 0 : 1));
  if (partition.length < 100) throw new Error(`world-v1 provides only ${partition.length} independent split paths`);
  const offset = (split === 'dev' ? 20261001 : 20261002) % partition.length;
  const chosen = [...partition.slice(offset), ...partition.slice(0, offset)];
  return chosen.map(([person, row], i) => {
    const birthplace = [...row.places][0], country = [...row.countries][0], capital = [...row.capitals][0], population = [...populations.get(capital)][0];
    const depth = 2 + i % 3, id = `f1-${split}-${String(i + 1).padStart(3, '0')}`;
    const knowledge = `@born_in predicate\n  args subject:entity object:entity\n@located_in predicate\n  args subject:entity object:entity\n@is_a predicate\n  args subject:entity object:entity\n@capital_of predicate\n  args subject:entity object:entity\n@population_of predicate\n  args subject:entity object:integer\n@f1 fact\n  holds born_in ${person} ${birthplace}\n@f2 fact\n  holds located_in ${birthplace} ${country}\n@f3 fact\n  holds is_a ${country} country\n${depth >= 3 ? `@f4 fact\n  holds capital_of ${capital} ${country}\n` : ''}${depth === 4 ? `@f5 fact\n  holds population_of ${capital} ${population}\n` : ''}`;
    const select = depth === 2 ? 'country' : depth === 3 ? 'capital' : 'population';
    const query = `@q query\n  select ?${select}\n  where all\n    born_in ${person} ?place\n    located_in ?place ?country\n    is_a ?country country\n${depth >= 3 ? '    capital_of ?capital ?country\n' : ''}${depth === 4 ? '    population_of ?capital ?population\n' : ''}  end\n`;
    const human = person.replaceAll('_', ' ');
    const question = split === 'dev' ? (depth === 2 ? `Which country contains ${human}'s birthplace?` : depth === 3 ? `What is the capital of the country containing ${human}'s birthplace?` : `What is the population of the capital of the country containing ${human}'s birthplace?`) : (depth === 2 ? `Name the nation where ${human} was born.` : depth === 3 ? `Identify the capital city of the nation in which ${human} was born.` : `How many residents does the capital city of ${human}'s birth nation have?`);
    const answer = depth === 2 ? country : depth === 3 ? capital : population;
    return {id, family: 'f1', variant: `world-v1-${depth}-hop`, depth, facts: worldFacts, materialized_facts: depth + 1, base_memory: 'world-v1', world_root: path.dirname(root), question, knowledge, query, expected: {feature: `Real world-v1 ${depth}-hop birthplace graph join`, status: 'supported', complete: true, rows: [{[select]: answer}], requires: ['facts']}, construction: {person, birthplace, country, capital, population}};
  });
}
