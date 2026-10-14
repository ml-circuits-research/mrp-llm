/**
 * Gold circuits of the common-sense questions (eval/commonsense/questions.jsonl), in the knowledge grammar, for the knowledge-level check of
 * experiment eval-commonsense-v1: `with` is the circuit a correct author writes when commonsense-v1 is imported, `without` the best circuit
 * the vocabulary of world-v1 alone allows (comparisons of years and containment are expressible there too), or null when nothing in that
 * vocabulary can state the question. Reviewed by commonsense-agent; the gold answers are in questions.jsonl.
 */
const exists = where => `@q query\n  mode exists\n  where ${where}\n`;
const all = (...atoms) => `all\n${atoms.map(a => '    ' + a).join('\n')}\n  end`;
const select = (vars, where) => `@q query\n  select ${vars}\n  where ${where}\n`;
const same = c => ({with: c, without: c});
export const GOLD_CIRCUITS = {
  cs01: same(exists('is_a violin musical_instrument')),
  cs02: same(exists('is_a whale mammal')),
  cs03: same(exists('is_a dog animal')),
  cs04: same(exists('is_a hammer tool')),
  cs05: same(exists('is_a apple fruit')),
  cs06: same(exists('is_a car vehicle')),
  cs07: same(exists('is_a gold metallic_element')),
  cs08: same(exists('is_a paris person')),
  cs09: same(exists('is_a albert_einstein city')),
  cs10: same(exists('is_a germany person')),
  cs11: {with: exists(all('capable_of bird ?v', 'compare ?v equal "fly"')), without: null},
  cs12: {with: exists('found_at pillow bedroom'), without: null},
  cs13: {with: exists(all('used_for knife ?v', 'compare ?v equal "cutting"')), without: null},
  cs14: same(exists('part_of finger hand')),
  cs15: {with: exists('older_than isaac_newton albert_einstein'), without: exists(all('born_on isaac_newton ?a', 'born_on albert_einstein ?b', 'compare ?a below ?b'))},
  cs16: {with: exists('contemporary_of albert_einstein napoleon'), without: exists(all('born_on albert_einstein ?a', 'died_on albert_einstein ?b', 'born_on napoleon ?c', 'died_on napoleon ?d', 'compare ?a below ?d', 'compare ?c below ?b'))},
  cs17: {with: exists('contemporary_of wolfgang_amadeus_mozart ludwig_van_beethoven'), without: exists(all('born_on wolfgang_amadeus_mozart ?a', 'died_on wolfgang_amadeus_mozart ?b', 'born_on ludwig_van_beethoven ?c', 'died_on ludwig_van_beethoven ?d', 'compare ?a below ?d', 'compare ?c below ?b'))},
  cs18: {with: exists('lived_before william_shakespeare isaac_newton'), without: exists(all('died_on william_shakespeare ?a', 'born_on isaac_newton ?b', 'compare ?a below ?b'))},
  cs19: {with: exists('outlived leonardo_da_vinci raphael'), without: exists(all('died_on leonardo_da_vinci ?a', 'died_on raphael ?b', 'compare ?a above ?b'))},
  cs20: {with: exists('older_than charles_darwin karl_marx'), without: exists(all('born_on charles_darwin ?a', 'born_on karl_marx ?b', 'compare ?a below ?b')), expect: true},
  cs21: {with: exists('younger_than karl_marx charles_darwin'), without: exists(all('born_on karl_marx ?a', 'born_on charles_darwin ?b', 'compare ?a above ?b'))},
  cs22: {with: exists('on_continent lyon europe'), without: exists('located_in lyon europe')},
  cs23: {with: exists('on_continent kyoto asia'), without: exists('located_in kyoto asia')},
  cs24: {with: exists('same_country_as munich hamburg'), without: exists(all('located_in munich ?k', 'located_in hamburg ?k', 'is_a ?k country'))},
  cs25: {with: exists(all('capital_of ?c kenya', 'on_continent ?c africa')), without: exists(all('capital_of ?c kenya', 'located_in ?c africa'))},
  cs26: {with: select('?c', 'on_continent milan ?c'), without: select('?c', all('located_in milan ?c', 'is_a ?c continent'))},
  cs27: {with: exists(all('base_amount kilogram ?a', 'base_amount grams ?b', 'compute ?x ?a times 1', 'compute ?y ?b times 900', 'compare ?x above ?y')), without: exists(all('unit_factor kilogram ?a', 'compute ?x ?a times 1', 'compare ?x above 900'))},
  cs28: {with: exists(all('base_amount mile ?a', 'base_amount km ?b', 'compare ?a above ?b')), without: null},
  cs29: {with: exists(all('base_amount hour ?a', 'base_amount second ?b', 'compute ?y ?b times 3000', 'compare ?a above ?y')), without: exists(all('unit_factor hour ?a', 'compare ?a above 3000'))},
  cs30: {with: select('?n', 'converts_to kilogram grams ?n'), without: select('?n', 'unit_factor kilogram ?n')},
};
/** cs31 and cs32 state their own facts in the message (turn-local evidence): they are checked through the author only. cs20 ("who was born first, Darwin or Marx?") is checked as "Darwin is older than Marx" (expect true). */
