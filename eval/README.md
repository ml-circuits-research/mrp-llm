# eval/ — evaluation data and suites

This directory holds the data of the evaluations: the sealed suites, the development sets, the capability battery's cases and ledger, the registry of every test and evaluation, and the reports. The code that runs evaluations lives in `tools/eval/` (harnesses) and `tools/capabilities/` (the battery); the unit and integration tests live in `tests/`. Nothing here trains a model. A passing comparison on finite worlds is never universal semantic equivalence. The validation procedure is the benchmark of symbolic reasoning against small LLMs, `experiments/proposal/symbolic-vs-llm-benchmark.md`.

What we test and measure, component by component, with the latest result and date of each entry: the inventory `docs/tests-inventory.html`, generated from `eval/registry.json` by `node tools/inventory/tests-and-evals.mjs`. A new test file, harness or data folder that is not registered there fails `npm test` (`tests/project/tests-inventory.test.mjs`).

## Layout of tests and evaluations (2026-10-03)

| Where | What |
|---|---|
| `tests/<component>/*.test.mjs` | Unit and integration tests and offline regressions, one folder per component: `sop/` (SOP Lang syntax, semantics, knowledge grammar), `reasoning/` (oracle, StrategyRouter, the LLM-agent baseline), `engines/` (the reasoning strategies and solvers), `memory/` (memory engines, base memories, sessions), `linker/`, `formalizer/` (step-by-step formalizer, request parser, query author), `routed/` (structure route, path B, jsEval, FOL, engineCode), `adapter/` (ChatSOPAdapter), `conversation/`, `ingestion/`, `analysis/`, `pworker/`, `server/`, `docs/`, `project/` (journal, notes, shards, leakage, the inventory guard), `eval-tooling/` (scorers and generators). `npm test` runs `tests/**/*.test.mjs`; `tests/helpers.mjs` and `tests/product-helpers.mjs` are shared, `tests/fixtures/` holds the fixtures. |
| `tools/eval/<component>/` | Evaluation harnesses, one folder per component: `books/` (the book problems), `formalization/` (`query-parsers.mjs`, `query-forms/` with `probe.mjs`, `stepbystep-protocol/`, `internal-reasoning/`, `generality/`, `regression/`: the live and offline formalization regression), `routed/` (`adapter/`, `engine-code/`, `structure/`), `ingestion/` (`ingest-v1.mjs`, `ingest-v2.mjs`), `kbqa/` (`cli.mjs` is the entry point), `linking/` (`suite.mjs`, `split.mjs`), `conversation/` (`smalltalk/`, `pragmatics/`), `chat/` (end-to-end checks against a running chat server: `e2e-chat.mjs`, `world-kb-chat.mjs`, `world-kb-report.mjs`), `analysis/`, `engines/` (router, slice, SQL and exact-decimal benchmarks), `review/` (collecting model output for the bulk LLM review), `symbolic-vs-llm/` (the benchmark), `pworker/` (Ploinky Workers latency under load). |
| `tools/eval/lib/` | The shared library of the harnesses: `chat-turn.mjs` (a harness's chat turn through ChatSOPAdapter, the chat's own backend), `session.mjs` (a private session over a base memory), `tier-parser.mjs` (request-parser settings for one tier), `direct-files.mjs`, and the graded-severity scale, mechanical checks and metrics `severity/` (DS012). |
| `tools/capabilities/` | The capability battery (L1, L2, L3) and its no-loss gate. |
| `eval/` | Data and suites only (below). The exceptions are code that belongs to a suite: the smoke suite's runner, adapters and knowledge validator (`eval/smoke-reasoning/`), the vendored reference engines, the leakage guard and the contracts export. |
| `eval/reports/current/`, `eval/reports/history/` | Regenerable observations (gitignored) and archived numbers. |
| `state/` | Run outputs of jobs and live evaluations (gitignored). |

Paths in history records (journal, notes, `PAS_TASK.md`, `CHANGES.md`, preregistrations, `status/experiments.json`) keep the names they had; `CHANGES.md` (2026-10-03) lists every move.

## Data in eval/

- `suites/kbqa-mintaka/`, `suites/kbqa-lcquad2/`, `suites/kbqa-simplequestions/`, `suites/kbqa-qald10/` — sealed natural-language KBQA suites run by the harness `tools/eval/kbqa/cli.mjs` over Wikidata slices as base memories (preregistered `eval-kbqa-v1`; staged 100, 300, all).
- `suites/linking-v1/` — the sealed linking suite for the KnowledgeLinker (`eval-linking-v1`, `eval-linking-v2`).
- `smoke-reasoning/` — the smoke reasoning cases and their runner `node eval/smoke-reasoning/run.mjs`, which executes every reasoning strategy; `validator.mjs` checks knowledge and query circuits.
- `capabilities/` — the capability battery's cases, capability list and no-loss ledger.
- `formalization-regression/` — the accumulating formalization regression cases.
- `commonsense/`, `world-kb/`, `smalltalk-v1/`, `pragmatics-v1/`, `analysis-v1/`, `ingest-v1/` — the questions, messages and gold of the respective evaluations.
- `reference-engines/` — vendored reference engines for differential tests.
- `registry.json` — the registry of every test group, evaluation, harness and data folder (rendered as `docs/tests-inventory.html`).
- `contracts.mjs` — machine-readable capability contracts used by `tools/capabilities.mjs`.
- `leakage.mjs` — the mechanical guard: generators and tuning code never read the test files of `eval/suites/**`.
- `reports/current/` — fresh observed results (regenerable, gitignored). `reports/history/` — archived results; historical numbers are never presented as new runs.

The step-by-step formalizer is measured by `tools/eval/formalization/query-parsers.mjs` (the world-kb questions and the query-forms dev set), one tier at a time (`--tier tiny|small|medium|good`; the one-shot calibration runner is archived in `probably_obsolete/one-shot-formalization/tools/eval/query-model-calibration/`); wrong circuits are counted apart from honest unknowns. The frozen small-model suites (`formalizer-v1`, `formalizer-ood-v1` and the dataset suites) are archived in `probably_obsolete/tinyLLMExperiments/eval/`.

## Rules

- A test is a lexically disjoint variant of the forms the system was built on (`tools/datasets/audit/content-word-overlap.mjs`, `tools/eval/formalization/query-forms/overlap.mjs`); no claim covers other forms.
- Stage evaluations (100, 300, then the full set) with a paired bootstrap interval, write the stopping rules into the preregistration (`status/preregistrations/`, [DS007](../docs/specs/DS007-experiment-preregistration.md)) and record every stop.
- Reproduce checks with the private native solvers selected explicitly: `Z3_BIN="$PWD/tools/.solvers/z3/bin/z3" SWIPL_BIN="$PWD/tools/.solvers/swi/swipl" node tools/verify.mjs`.

## Owning specifications

- [DS012 evaluation metrics](../docs/specs/DS012-evaluation-metrics.md) — one definition per metric.
- [DS007 experiment preregistration](../docs/specs/DS007-experiment-preregistration.md) — what is frozen before a holdout is used, and the promotion gates.
- [DS010 engine and solver comparison](../docs/specs/DS010-engine-and-solver-comparison.md) — memory-engine, reasoning-strategy and solver comparison reports.
- [DS014 model surface](../docs/specs/DS014-model-surface.md) — the circuit language the coding agent writes.
- [DS015 diversity generator](../docs/specs/DS015-diversity-generator.md) — the generator behind synthetic forms.
