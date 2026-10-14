/** Source rights records for the public datasets that inspire ChatSOP corpora.
 *
 * One record per upstream source: where it lives, its licence as known, what ChatSOP takes from it (structure,
 * label types, phenomena, statistics) and what it never takes (text). Builders stamp `rightsFor()` into row
 * provenance and manifests; `tools/datasets/no-copy.mjs` enforces the no-copy guarantee; `probably_obsolete/tinyLLMExperiments/datasets/SOURCES.md`
 * is the human-readable form. The release decision is the owner's decision of 2026-09-28 recorded in DS011.
 */

export const OWNER_DECISION = Object.freeze({
  date: '2026-09-28',
  decision: 'owner-released-inspired-by',
  summary: 'Corpora inspired by QQP, PAWS, ProofWriter, AmbigNQ, QA2D and SQuAD are released from quarantine: their texts are original work that borrows structure, label types, phenomena and statistics, never source text, and serves a different purpose (NL-to-SOP formalization).',
  spec: 'docs/specs/DS011-source-rights.md',
});

/** What every inspired-by corpus never takes from a source. */
export const NEVER_TAKEN = Object.freeze([
  'source sentences, questions, passages, answers or declarative rewrites (verbatim, translated or lightly edited)',
  'source entity names, titles or row identifiers in any natural-language field',
  'source labels as gold: every ChatSOP target is authored and executed independently',
]);

export const SOURCES = Object.freeze({
  qqp: {
    name: 'Quora Question Pairs (GLUE QQP)',
    url: 'https://quoradata.quora.com/First-Quora-Dataset-Release-Question-Pairs',
    mirror: 'https://huggingface.co/datasets/nyu-mll/glue (qqp config)',
    licence: 'Quora first release terms (non-commercial research use with attribution); no SPDX licence identified',
    attribution: 'Quora question pairs, Quora Inc.; GLUE benchmark packaging',
    taken: ['equivalent/non-equivalent pair label types', 'question-type distribution (wh-words, yes/no, how-many)', 'paraphrase operations (reordering, synonym substitution, pronoun and person switch, question-frame change, modifier addition)', 'conversational noise rates (lowercase starts, missing question marks, chat spellings)', 'multi-sentence question discourse shapes'],
  },
  paws: {
    name: 'PAWS-Wiki labeled final',
    url: 'https://github.com/google-research-datasets/paws',
    mirror: 'https://huggingface.co/datasets/google-research-datasets/paws',
    licence: 'PAWS LICENSE: may be freely used for any purpose, acknowledgement of Google LLC appreciated; underlying Wikipedia text CC BY-SA 4.0',
    attribution: 'PAWS: Paraphrase Adversaries from Word Scrambling, Google LLC',
    taken: ['high-lexical-overlap contrast design (same words, different meaning)', 'word-swap and argument-swap statistics', 'clause and adverbial movement as meaning-preserving operations', 'label balance of paraphrase versus non-paraphrase'],
  },
  proofwriter: {
    name: 'ProofWriter (OWA structured)',
    url: 'https://allenai.org/data/proofwriter',
    mirror: 'https://huggingface.co/datasets/rlhf-and-friends/proofwriter',
    licence: 'No dataset licence file in the official release; secondary sources report CC BY 4.0 (unconfirmed)',
    attribution: 'ProofWriter, Allen Institute for AI (Tafjord, Dalvi, Clark 2021)',
    taken: ['True/False/Unknown status balance under the open-world assumption', 'derivation-depth distribution', 'rule body sizes and rule surface forms (if-then, generic plural, all-quantified)', 'explicit negation in facts, rules and questions'],
  },
  ambignq: {
    name: 'AmbigNQ (AmbigQA)',
    url: 'https://nlp.cs.washington.edu/ambigqa/',
    mirror: 'https://github.com/shmsw25/AmbigQA',
    licence: 'CC BY-SA 3.0 (notice bundled in the publisher release ZIP); underlying Natural Questions CC BY-SA 3.0',
    attribution: 'AmbigQA: Answering Ambiguous Open-domain Questions (Min et al. 2020), University of Washington',
    taken: ['ambiguity types (entity reference, time dependency, answer type, property/sense, event reference)', 'single-answer versus multiple-interpretation proportions', 'disambiguation operations (added time, added type or qualifier, added property)'],
  },
  qa2d: {
    name: 'QA2D (question to declarative)',
    url: 'https://github.com/kelvinguu/qanli',
    mirror: 'https://huggingface.co/datasets/domenicrosati/QA2D',
    licence: 'Code MIT (Demszky 2019); dataset licence not stated (mirror card: Needs More Information); upstream SQuAD CC BY-SA 4.0 plus RACE/NewsQA/QAMR/MovieQA terms',
    attribution: 'Transforming Question Answering Datasets Into Natural Language Inference Datasets (Demszky, Guu, Liang 2018)',
    taken: ['question-to-declarative rewrite operations (wh-fronting undone, auxiliary inversion undone, answer slot position)', 'question-type distribution', 'declarative length ratios'],
  },
  squad: {
    name: 'SQuAD v2.0 (dev)',
    url: 'https://rajpurkar.github.io/SQuAD-explorer/',
    mirror: null,
    licence: 'CC BY-SA 4.0',
    attribution: 'SQuAD 2.0, Stanford NLP (Rajpurkar, Jia, Liang 2018)',
    taken: ['answerable versus unanswerable question design', 'the separately recorded sealed source-reference derivative (unchanged)'],
  },
});

/** Licence of the authored corpus text itself: original project work under the repository licence. */
export const AUTHORED_LICENCE = 'MIT (repository LICENSE); original ChatSOP authored text';

/** Row-level provenance stamp for a row whose design was inspired by `sources` (ids from SOURCES). */
export function rightsFor(sources = []) {
  for (const id of sources) if (!SOURCES[id]) throw Error(`Unknown inspiration source: ${id}`);
  return {
    license: AUTHORED_LICENCE,
    rights_decision: OWNER_DECISION.decision,
    rights_decision_date: OWNER_DECISION.date,
    inspired_by: sources.map(id => ({ id, name: SOURCES[id].name, url: SOURCES[id].url, licence: SOURCES[id].licence })),
    text_copied: false,
  };
}

/** Compact per-row rights stamp: the manifest carries the full block (names, URLs, licences, never_taken). */
export function rowRights(sources = []) {
  for (const id of sources) if (!SOURCES[id]) throw Error(`Unknown inspiration source: ${id}`);
  return { license: AUTHORED_LICENCE, rights_decision: OWNER_DECISION.decision, inspired_by: [...sources], text_copied: false };
}

/** Manifest-level rights block for a corpus inspired by `sources`. */
export function manifestRights(sources = []) {
  const stamp = rightsFor(sources);
  return { ...stamp, never_taken: NEVER_TAKEN, no_copy_check: 'node tools/datasets/no-copy.mjs', spec: OWNER_DECISION.spec };
}
