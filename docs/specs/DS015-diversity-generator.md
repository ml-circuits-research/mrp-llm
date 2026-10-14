---
title: DS015-diversity-generator
summary: The diversity generator (mined source inventory, IR-based realization, noise, quotas, split grouping), the no-copy and source-rights checks, and its role as a source of lexically disjoint benchmark instances.
---

# DS015 — Diversity generator

## Scope and status

The diversity generator (`tools/datasets/diversity/`) produces natural-language questions and statements with real rather than templated variety, together with an independent verification world that executes to a gold answer. Its original product was the training and test corpora of the frozen tiny-model branch; those corpora, their builders and their audit now sit in `probably_obsolete/tinyLLMExperiments/` (`datasets/`, `datasets_archive/`, `tools/`). The generator now serves the symbolic-versus-LLM benchmark (`experiments/proposal/symbolic-vs-llm-benchmark.md`): its families (`families.mjs` proof depth, lookup, count, joins, temporal, negation and closure, ambiguity) are the source of generated instances whose fresh entity and predicate names make development and sealed sets lexically disjoint variants of the same forms ([DS012](specsLoader.html?spec=DS012-evaluation-metrics.md) "Evaluation obligations"). A corpus builder for the benchmark is part of that plan and is not documented here as built.

Rights: generated text is inspired by QQP, PAWS, ProofWriter, AmbigNQ, QA2D and SQuAD under the owner's decision of 2026-09-28 ([DS011](specsLoader.html?spec=DS011-source-rights.md)). It takes structure, label types, phenomena and statistics, never text. `tools/datasets/rights.mjs` supplies the provenance stamp (`rowRights`, `manifestRights`: `{license, rights_decision, inspired_by, text_copied: false}`), `tools/datasets/no-copy.mjs` proves the no-copy guarantee, and the source list is `probably_obsolete/tinyLLMExperiments/datasets/SOURCES.md` until the benchmark data carries its own.

## Generator modules

| Module | Role |
| --- | --- |
| `mine-sources.mjs`, `inventory/inventory.json` | Streams the cached sources in `datasets_sources/` and writes a diversity inventory: question types and masked skeletons, paraphrase operations, ambiguity types, reasoning depth and negation, declarative rewrites, discourse forms, noise rates. Every category is a documented lexical heuristic with counts; examples are masked skeletons (closed-class words kept, content words replaced by `X`), never source text. |
| `families.mjs`, `families-questions.mjs`, `families-expansion.mjs` | Produce a canonical IR (predicate ids, domain roles, entity ids, ISO times) and a message plan per family. |
| `domains.mjs`, `frames.mjs`, `realize.mjs`, `english.mjs`, `relation-words.mjs` | Realize each proposition through one construction of the predicate lexicon, outer question frames and discourse arrangements; `relationWordProblems` checks that every content word of a relation phrase has an inflected form in the message. |
| `names.mjs`, `entities.mjs` | Natural, culturally mixed names; ids are readable slugs used only in the verification world; no counters or hashes reach text. |
| `noise.mjs`, `text.mjs` | Deliberate, labelled typing noise and code-switching (`row.noise`, `row.noise_level`, `row.code_switch`); quoted values are re-aligned to the final text. |
| `unclear.mjs`, `long.mjs`, `simple-text.mjs` | Unclear messages, long multi-clause messages and plain-text rendering of a circuit. |
| `ir.mjs`, `printers.mjs` | The surface IR and pluggable printers (`registerPrinter`) that print a circuit in the SOP surface of [DS014](specsLoader.html?spec=DS014-model-surface.md). |
| `execute.mjs` | Executes the verification target against the row's world (`lib/row-world.mjs`) to obtain the gold. |
| `quotas.mjs`, `heldout.mjs` | Quotas, mix rules, banned patterns, template masking and held-out names, constructions and domains. |
| `generate.mjs` | The core: schedules families, noise and splits, realizes each case into independent surfaces, links the strings to the verification world and executes the gold. |

## Model input and verification scaffolding

The input of an authoring or answering system under test is the message only (`question`). The verification world (`ontology_sop`, `setup_sop`, `verification_context`, `expected`) is evaluation scaffolding: it produces the gold and is never part of a prompt, except where a benchmark arm is defined to receive the retrieved slice as evidence (arm A of the benchmark plan). A row carries its own entities and facts; predicate declarations and converse-equivalence rules that are identical for every row are stored once per set.

## Splits and leakage

Cases that share a template are grouped before splitting, so a template never straddles development and test. Generated sets are checked by `tools/datasets/audit/content-word-overlap.mjs` (exact, normalized and lexical duplicates fail closed) and `tools/datasets/no-copy.mjs`; generators never read sealed tests (`eval/leakage.mjs`).

## Checks

```sh
node tools/datasets/diversity/mine-sources.mjs          # rebuild the inventory
node tools/datasets/no-copy.mjs --files a.jsonl,b.jsonl --name <set>   # no 4-gram shared with a row's own source, no 8-gram with any source, no ids in text
node tools/datasets/audit/content-word-overlap.mjs      # lexical duplicates between sealed and development rows
```

Measured values live in reports under `eval/reports/current/`; they are observations, not properties recorded here.

## Benchmark worlds

`tools/datasets/diversity/build-benchmark.mjs` writes oracle-verified development worlds in the smoke case layout under `eval/smoke-reasoning/bench/cases/`, with deterministic English `source.md`, independent construction expectations and a manifest. F1 uses actual world-v1 multi-hop graph joins and the query-forms gold procedure; F2–F9 cover aggregate/rank, open/closed completeness, reachability, finite constraints, intervals, defaults/exceptions, contradiction and configurable scale. The builder refuses sealed generation; `sealed-generator-config.json` records the separate seed and future `eval/suites/symbolic-vs-llm-v1/` boundary. The source audit discovers the generator modules automatically through `eval/leakage.mjs`; lexical overlap is audited independently, never by importing sealed auditors into generators.

Benchmark predicate declarations provide generic labels and descriptions of roles, derived semantics and closedness, never answers or case-specific hints. A grouped aggregate question names only restrictions represented by its relation schema; firm-scoped totals bind the firm through the source relation. Reachability exposes both requested origin and destination with general recursive rules, not a hidden fixed-source unary relation. Integrity questions that select constraint identifiers ask which constraint is violated and use the witness in its declared argument position. Numeric conjunctions keep one shared assignment scope and the original domains. Reconstruction of a development identity preserves its independently constructed semantic answer; changed question, vocabulary or schema hashes are recorded separately from exact-input paired measurements.

## Open items

1. AmbigNQ answer-type ambiguity is not generated.
