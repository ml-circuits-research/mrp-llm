/** Text normalization shared by the duplicate checks (tools/datasets/audit/content-word-overlap.mjs). The train/dev inputs of the frozen three datasets
 * (formalizer-v1 records, diversified paraphrases, new cases) were read here; that builder moved with the datasets to
 * probably_obsolete/tinyLLMExperiments/tools/datasets/three-datasets/inputs.mjs.
 */

/** Normalized text used to detect exact duplicates across splits (case, diacritics, punctuation and spacing folded). */
export const normalText = text => String(text).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
