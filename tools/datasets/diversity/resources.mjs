/** Summary of the authored generator resources for the inventory: names, constructions, frames, noise and
 * code-switching models, unclear generators and family templates, with counts and generated examples. */
import { GIVEN_NAMES, SURNAMES, PLACES, ORG_PATTERNS, cultures } from './names.mjs';
import { PREDICATES, ENTITY_POOLS, CLOSED_ROLES, constructionCount } from './domains.mjs';
import { YES_NO, WH, CLAIM_CHECK, DISCOURSE, JOINERS } from './frames.mjs';
import { CODE_SWITCH_KINDS, DEFAULT_TYPO_WEIGHTS, addNoise, codeSwitch, typoWeights } from './noise.mjs';
import { UNCLEAR_GENERATORS, makeUnclear } from './unclear.mjs';
import { FORMERLY_BLOCKED } from './families.mjs';
import { ALL_FAMILIES as FAMILIES } from './families-questions.mjs';
import { EntityWorld } from './entities.mjs';
import { QUOTAS } from './quotas.mjs';
import { rng } from './text.mjs';

const count = (list, key) => list.reduce((t, item) => { t[item[key]] = (t[item[key]] ?? 0) + 1; return t; }, {});

export function authoredSummary({ noiseRates = {}, typos = null } = {}) {
  const random = rng('inventory-examples');
  const diacritics = [...GIVEN_NAMES.map(n => n.name), ...Object.values(SURNAMES).flat(), ...Object.values(PLACES).flat()].filter(s => /[ăâîșțşţéèüöőűłńśźżçñãõ]/i.test(s));
  const families = Object.fromEntries(Object.keys(FAMILIES).map(name => {
    const examples = [];
    for (let i = 0; i < 2; i++) {
      const world = new EntityWorld(rng(`inventory:${name}:${i}`));
      const spec = FAMILIES[name]({ random: rng(`inventory:${name}:${i}:r`), world });
      examples.push({ variant: spec.variant, expect: spec.expect, canonical_query: spec.canon.query ?? null, stated: spec.canon.stated.length, assumed: spec.canon.assumed.length });
    }
    return [name, { formerly_blocked: FORMERLY_BLOCKED.includes(name), examples }];
  }));
  const sample = 'Ana lucrează la Nordwind Systems din Cluj-Napoca. Poți să verifici dacă e încă acolo?';
  return {
    names: {
      given_names: GIVEN_NAMES.length, by_culture: count(GIVEN_NAMES, 'culture'), cultures: cultures.length,
      surnames: Object.values(SURNAMES).flat().length, surname_cultures: Object.keys(SURNAMES).length,
      places: Object.fromEntries(Object.entries(PLACES).map(([k, v]) => [k, v.length])), organization_patterns: Object.fromEntries(Object.entries(ORG_PATTERNS).map(([k, v]) => [k, v.en.length])),
      with_diacritics: diacritics.length, diacritic_examples: diacritics.slice(0, 12), person_full_name_combinations: GIVEN_NAMES.length * Object.values(SURNAMES).flat().length,
      rule: 'Natural names only: no counters, hashes or ids in text; a quarter of names are reserved for the sealed test split.',
    },
    lexicon: {
      predicates: Object.keys(PREDICATES).length, constructions: constructionCount(), closed_roles: CLOSED_ROLES,
      constructions_by_predicate: Object.fromEntries(Object.entries(PREDICATES).map(([id, p]) => [id, { en: p.en.map(c => c.rel), ro: p.ro.map(c => c.rel), converse: [...p.en, ...p.ro].filter(c => c.converse).map(c => c.rel) }])),
      entity_pools: Object.fromEntries(Object.entries(ENTITY_POOLS).map(([k, v]) => [k, v.length])),
    },
    frames: { yes_no: { en: YES_NO.en.length, ro: YES_NO.ro.length }, wh: { en: WH.en.length, ro: WH.ro.length }, claim_check: { en: CLAIM_CHECK.en.length, ro: CLAIM_CHECK.ro.length },
      discourse: { en: DISCOURSE.en.length, ro: DISCOURSE.ro.length, by_shape: count([...DISCOURSE.en, ...DISCOURSE.ro], 'shape'), by_certainty: count([...DISCOURSE.en, ...DISCOURSE.ro], 'certainty') },
      joiners: { en: JOINERS.en.length, ro: JOINERS.ro.length } },
    noise_model: {
      operations_en: ['typo', 'lowercase_start', 'drop_question_mark', 'missing_apostrophe', 'chat_spelling', 'lowercase_i', 'repeated_punctuation', 'space_before_punctuation', 'no_space_after_comma'],
      operations_ro: ['strip_diacritics', 'typo', 'lowercase_start', 'drop_question_mark', 'chat_spelling', 'repeated_punctuation', 'space_before_punctuation', 'no_space_after_comma'],
      typo_operation_weights: typos ? typoWeights(typos) : DEFAULT_TYPO_WEIGHTS, typo_weights_source: typos ? 'measured QQP hapax typos (typo_model_measured)' : 'default',
      measured_rates_qqp: noiseRates.qqp ?? null, clean_baseline_paws: noiseRates.paws ?? null,
      row_rate: 0.22, entity_surfaces_protected_from_character_typos: true,
      example: addNoise('Does Maria still work at Nordwind Systems?', { language: 'en', random, surfaces: ['Maria', 'Nordwind Systems'], count: 2 }),
    },
    code_switching_model: { kinds: CODE_SWITCH_KINDS, row_rate: 0.15, labelled_as: 'row.code_switch {kind, matrix, embedded, inserted}',
      examples: [codeSwitch(sample, { matrix: 'ro', random, kind: 'ro_matrix_en_insertion', names: ['Ana'] }), codeSwitch('Does Ana still work at Nordwind Systems?', { matrix: 'en', random, kind: 'en_matrix_ro_tag', names: ['Ana'] })] },
    unclear_generators: Object.fromEntries(Object.entries(UNCLEAR_GENERATORS).map(([kind, methods]) => [kind, { methods: methods.map(m => m.method), examples: ['en', 'ro'].map(language => makeUnclear(kind, { random, language })?.text) }])),
    families,
    quotas: QUOTAS,
  };
}
