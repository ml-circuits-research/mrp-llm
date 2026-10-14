/** Resource partitions of the generated corpora (DS015 "Split grouping and leakage" and "Out-of-distribution
 * suite").
 *
 * Every realization resource falls in one of three roles:
 *   - `ood`: out-of-distribution only. It never occurs in formalizer-v1 (train, dev or test) and is used only by
 *     the out-of-distribution suite. The documented subset is `OOD_ONLY_FRAMES` below plus every construction
 *     flagged `oodOnly` in domains.mjs (`HELDOUT_CONSTRUCTIONS`).
 *   - `test`: reserved for sealed evaluation (the formalizer-v1 test split and the OOD suite); never in train/dev.
 *   - `shared`: train and dev (and the sealed test when no reserved option fits).
 *
 * Frame tables and construction lists are partitioned over their FULL list here, by id. Before this registry the
 * Chooser partitioned whatever filtered sub-list a call site passed (for example only the plain yes/no frames, or
 * no tag after a negation), so one frame could be test-reserved in one call and shared in another, and frames
 * leaked between the sealed suites and train/dev. Lists not registered here are still partitioned per call.
 */
import { YES_NO, WH, CLAIM_CHECK, DISCOURSE, JOINERS, TIME_FRAMES, WHY_FRAMES } from './frames.mjs';
import { PREDICATES } from './domains.mjs';
import { hash32 } from './text.mjs';

/** Share of a partitioned list reserved for the sealed test: one option in HELDOUT_MODULUS. */
export const HELDOUT_MODULUS = 4;

/**
 * Lead-in and question frames reserved for the out-of-distribution suite, per language. Whole question forms
 * are held out where a form has only these frames: in English the tail question ("…, do you know?", "…, if you
 * know?"), the opinion frame ("Would you say that …") and the alternative question ("… or not?"); in Romanian
 * the alternative question ("… sau nu?") and the tail question ("…, te rog?"). The discourse shapes
 * `parenthetical` (EN) and `question_then_elaboration` (EN and RO) are held out with their frames. Inline lists
 * of generate.mjs (`conj.*`, `multi.*`) are named by their option ids.
 */
export const OOD_ONLY_FRAMES = Object.freeze({
  en: ['yn_would_you_say', 'yn_or_not', 'yn_do_you_know_tail', 'yn_help_me', 'wh_if_you_know', 'wh_remind_me', 'cc_quoted',
    'd_for_context', 'd_because', 'when_roughly', 'since_first', 'until_last', 'long_time', 'times_occasions', 'why_what_makes', 'conj.en.4', 'multi.en.2'],
  ro: ['yn_ro_sau_nu', 'yn_ro_chiar', 'wh_ro_te_rog', 'wh_ro_amintesti', 'cc_ro_confirma', 'd_ro_intreb', 'when_ro_ce_ani', 'since_ro_an',
    'long_ro_perioada', 'times_ro_frecvent', 'why_ro_cum_de', 'conj.ro.3', 'multi.ro.2'],
});
/** Question forms (`surface_design.form`) and discourse shapes (`surface_design.shape`) whose every frame is OOD-only. */
export const OOD_ONLY_FORMS = Object.freeze({ en: ['tail_question', 'opinion', 'alternative'], ro: ['alternative', 'tail_question'] });
export const OOD_ONLY_SHAPES = Object.freeze({ en: ['parenthetical', 'question_then_elaboration'], ro: ['question_then_elaboration'] });

const constructionIds = () => Object.entries(PREDICATES).flatMap(([id, spec]) => ['en', 'ro'].flatMap(language => spec[language].filter(c => c.oodOnly).map(c => `${id}.${c.id}`)));
/** Every OOD-only resource id (frames and held-out constructions). */
export const OOD_ONLY = new Set([...OOD_ONLY_FRAMES.en, ...OOD_ONLY_FRAMES.ro, ...constructionIds()]);
export const isOodOnly = id => OOD_ONLY.has(id);

/** Test-reserved options of one list: floor(n/4) of the non-OOD options (at least one from three up), lowest hash first. */
export function testReserved(options) {
  const rest = options.filter(option => !OOD_ONLY.has(option.id));
  if (rest.length < 3) return new Set();
  const ranked = [...rest].sort((a, b) => hash32(`heldout:${a.id}`) - hash32(`heldout:${b.id}`) || String(a.id).localeCompare(String(b.id)));
  return new Set(ranked.slice(0, Math.max(1, Math.floor(rest.length / HELDOUT_MODULUS))).map(option => option.id));
}

/** The registered full lists: frame tables (discourse frames grouped as the call sites choose them) and constructions. */
function registeredLists() {
  const lists = [];
  for (const language of ['en', 'ro']) {
    lists.push(YES_NO[language], WH[language], CLAIM_CHECK[language], JOINERS[language], WHY_FRAMES[language]);
    for (const kind of Object.keys(TIME_FRAMES)) lists.push(TIME_FRAMES[kind][language]);
    const groups = new Map();
    for (const frame of DISCOURSE[language]) {
      const key = `${frame.certainty}:${Boolean(frame.speaker)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(frame);
    }
    lists.push(...groups.values());
  }
  for (const [id, spec] of Object.entries(PREDICATES)) for (const language of ['en', 'ro']) lists.push(spec[language].map(c => ({ id: `${id}.${c.id}` })));
  return lists;
}

/** id → 'ood' | 'test' | 'shared' for every registered resource. */
export const RESOURCE_ROLES = (() => {
  const roles = new Map();
  for (const list of registeredLists()) {
    const reserved = testReserved(list);
    for (const option of list) roles.set(option.id, OOD_ONLY.has(option.id) ? 'ood' : reserved.has(option.id) ? 'test' : 'shared');
  }
  for (const id of OOD_ONLY) roles.set(id, 'ood');
  return roles;
})();

/** Resource ids of a row by category, for the overlap metric: lead-in frames and realization constructions. */
const CONSTRUCTION_ID = /^([a-z_]+)\.(en|ro)\.\d+$/;
/** Markers in `question_frame`/`discourse` that are not frames. */
const NOT_FRAMES = new Set(['question_only', 'statement_only', 'none', 'long_message', 'composed']);
export function rowResources(row) {
  const ids = row.surface_design?.resources ?? [];
  const constructions = ids.filter(id => CONSTRUCTION_ID.test(id) && PREDICATES[CONSTRUCTION_ID.exec(id)[1]]);
  // The row's own lead-in frames, plus every registered frame among its resources (the parts of a long message).
  const own = [row.surface_design?.question_frame, row.surface_design?.discourse].filter(id => id && !NOT_FRAMES.has(id));
  const frames = [...new Set([...own, ...ids.filter(id => RESOURCE_ROLES.has(id) && !CONSTRUCTION_ID.test(id))])];
  return { frames, constructions };
}
