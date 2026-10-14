---
title: DS007-experiment-preregistration
summary: Prospective controlled hypotheses, experiment identity, grouped holdouts, result reporting, resource budgets, planned study arms and publication obligations.
---

## Introduction

An experiment is a predeclared comparison, not a retrospective description of a successful run. This specification defines what an operator must freeze **before** using a holdout or running a model. The thresholds below are proposed promotion gates to freeze for a particular approved study, **not measured results** or model accuracy claims. No model is trained in this project. Evaluation obligations (sealed tests, disjoint variants, staged stopping) are in [DS012](specsLoader.html?spec=DS012-evaluation-metrics.md); the frozen branch's case and split rules are in `probably_obsolete/tinyLLMExperiments/specs/DS008-data-evaluation.md`.

## Core Content

### Registry and experiment identity

Every proposed experiment is registered in `status/experiments.json` (format `chatsop-experiments-v1`), read and written through `lib/journal.mjs` and shown on the server's `/experiments` pages (one page per entry). An entry records `id`, `hypothesis`, `preregistration` (a link to the frozen record this specification requires), `data_version`, `status` (`proposed`, `preregistered`, `approved`, `running`, `done` or `abandoned`), `results` and `conclusions`. An entry exists from preregistration on; `running` and `done` entries exist only for runs the owner approved. Meaningful work and owner decisions around an experiment are appended to the project journal `status/journal.jsonl`; the journal records what happened and points at evidence, it is not evidence of a result by itself.

An evaluation run identifies itself: the evaluation harness (the formalizer evaluator `evaluate` of the frozen branch, `probably_obsolete/tinyLLMExperiments/eval/run.mjs`, is the model of this record) produces `format`, `source`, `suite_sha256`, `config_sha256`, `runtime`, `model_manifest`, `model_identity_verified`, `requests_succeeded`, `evaluation_valid` and `records`. A manifest is supplied provenance, **not** an attestation of endpoint weights. `probably_obsolete/tinyLLMExperiments/tests/contracts-boundary.test.mjs` (“experiment hash identifies fixed suite/config…”) executes the boundary: evaluating a fixed real row with an explicit predictor yields SHA-256 suite/config identities, and changing only `config.memory.engine` changes `config_sha256` but not `suite_sha256`; a duplicate row `id` rejects the run, and supplying `modelManifest` leaves `model_identity_verified:false`, because an opaque supplied manifest is not proof of weights or neural inference.

### Experiments

`status/experiments.json` records every study that produces a number the project may cite, not only preregistered ones. Each entry has the same fields, so every study can be read the same way on `/experiments/<id>`:

| Field | Content |
| --- | --- |
| `id`, `name` | Stable identifier (never reused or renamed) and a one-line human name. |
| `category` | `preregistered` (a frozen DS007 record exists), `reference-baseline` (a comparison point, not a controlled arm) or `data-study` (data, annotation or agreement work without a model under test). A missing category means `preregistered`. |
| `kind`, `owner`, `registered_at` | Free-text kind, the actor that runs it, and when the entry was first written. |
| `hypothesis`, `preregistration` | What is tested, and the frozen record's path. A `reference-baseline` or `data-study` writes `none: <why>` instead. |
| `data_version`, `datasets` | Data identity in one line, and each dataset or suite with `name`, `path`, `sha256`, `rows` and `role`. |
| `models` | Each model with `name`, `identity` (repository and revision), `version` (run, quantization, file hash), `runtime` and `status`. |
| `status` | `proposed`, `preregistered`, `approved`, `running`, `done` or `abandoned`. |
| `done`, `metrics` | What was actually done, and the endpoints with their denominators. |
| `results_summary`, `results` | A human-readable summary with counts, and machine-readable numbers (for example the per-arm partial results that `probably_obsolete/tinyLLMExperiments/tools/research/record-result.mjs` writes). |
| `deviations` | Each change after registration: `id`, `at`, `what`, `why`, `effect`. |
| `conclusions`, `reports` | The conclusion, including a negative or inconclusive one, and links to the reports and raw predictions. |

`lib/journal.mjs` validates the required fields (`id`, `hypothesis`, `preregistration`, `data_version`, `status`) and the types of the optional ones; `tests/project/journal.test.mjs` requires every running or done `preregistered` entry to point at an existing frozen record. Several agents write the file: each re-reads it immediately before writing, changes only its own entries (or adds missing fields to another's), and never drops fields it does not own.

**Naming.** An id is lower-case words joined by hyphens and ends in a protocol version: `<scope>-<topic>-v<N>`. The scope says what kind of study it is: a model study is named after its subject (`formalizer-size-v1`, a historical id), an inference-only evaluation starts with `eval-` (`eval-spellfix-preproc-v1`, `eval-haiku-prompted-baseline-v1`) and a data or annotation study with `data-` (`data-wild-pilot-v1`). A changed protocol, suite or decision rule is a new id with the next version, never an edit of a frozen record. Runs inside an experiment keep their own identifiers (`fv1-size-a4`).

### Tasks and topic notes

The experiment registry says what a study tested and obtained; two further records keep the project's history readable over time, on the server's `/experiments` pages ([DS009](specsLoader.html?spec=DS009-local-server.md)).

**Tasks** (`status/tasks.json`, format `chatsop-tasks-v1`, `lib/tasks.mjs`). One record per major piece of work (a review, a language redesign, a data build, a baseline, a diagnosis, a plan), including those without a model under test. The registry also holds `phase` (`name`, `since`, `detail`): the current project phase as last written by an agent.

| Field | Content |
| --- | --- |
| `id`, `kind`, `title` | Stable identifier (lower-case, never reused; not `api`, `topics`, `topic`, `reports`, `report`, `timeline`, `questions` or `tasks`), `task` or `experiment`, and a one-line title. A task that is an experiment of the registry uses the experiment's id. |
| `status`, `started_at`, `updated_at` | `open`, `running`, `paused`, `blocked`, `done` or `abandoned`, and ISO times. |
| `summary` | Two or three sentences for the index. |
| `owner` | Markdown: what the owner asked, why, and the owner's decisions and corrections along the way, quoted or faithfully paraphrased from journal decision events and `questions.md`. |
| `agents` | Markdown: what agents analysed, tried and ran (including failed and restarted attempts), what was obtained with numbers and denominators, the conclusions. |
| `follow_ups`, `links` | Open follow-ups, and evidence paths. |
| `topics`, `experiments`, `match` | The topic ids, experiment ids and phrases that relate notes and journal events to the task (case-insensitive substring match on their text and links). |

The task page shows the two sides apart: **Owner** and **Agents / analysis**, each with a newest-first stack of the related notes and journal events. Several agents may write the file: re-read it immediately before writing, change only your own records and never drop fields you do not own.

**Topic notes** (`status/topics.json`, format `chatsop-topics-v1`; `status/notes/<topic>.jsonl`; `lib/notes.mjs`; CLI `node tools/notes.mjs add|list|topics|validate`). A topic has a stable `id`, a `title` and a one-paragraph `scope`. A note is one JSON line:

| Field | Content |
| --- | --- |
| `id` | Unique across the store; generated as `<topic>-<yyyymmdd-hhmmss>-<6 hex of the title>` unless given. |
| `ts` | ISO time of what the note records (a note written later about an earlier event carries the event's time and says so in its body). |
| `topic` | A registered topic id; the note is stored in that topic's file. |
| `kind` | `decision`, `suggestion`, `analysis`, `observation`, `experiment`, `result`, `plan`, `question` or `correction`. |
| `author` | `owner` for the owner's requests and decisions (from journal events with state `decision` or actor `owner`/`owner-via-orchestrator`), else the agent or review that produced it (`orchestrator`, `training-agent`, `Fable review`, …). |
| `title`, `body`, `links` | A one-line title, a Markdown body with the numbers and their denominators, and repository paths or URLs of the evidence (reports, logs, records). |
| `supersedes` | Optional: the id of an earlier note that this one corrects or replaces. |

Notes are append-only: a note is never edited or deleted, a correction is a new note whose `supersedes` names the old one, and both stay visible ("superseded by …" on the old note). `appendNote` refuses an unknown topic, a duplicate id, a `supersedes` that names no existing note and a file whose last byte is not a newline; `validate` checks the whole store. Failed, restarted and invalidated attempts are recorded like successes, with their logs. Notes and the journal record what happened and what was concluded; they are not evidence by themselves and point at the reports that are. Like the journal, the notes are frozen history for `tools/check-spec-refs.mjs`: they may cite former specification ids, which the site resolves through `docs/specs/aliases.json`.

### Registered experiments

The registry `status/experiments.json` and the frozen records under `status/preregistrations/` keep every earlier experiment, including those of the frozen tiny-model branch (formalizer fine-tuning, UD rules, spelling and translation preprocessing, textToCleanEnglish, SymbolicLM adoption and composed-paragraph evaluations). Those records are historical evidence: their code, data and reports are in `probably_obsolete/tinyLLMExperiments/` and `eval/reports/history/`, and none of them is a current claim.

**Planned: `eval-symbolic-vs-llm-v1`.** The prospective record `status/preregistrations/eval-symbolic-vs-llm-v1.json` is a DRAFT until `frozen: true` is recorded before sealing or measurement. It specifies arms A/A'/B/C/D, hypotheses H1–H4, dev/sealed seeds, paired practical-margin and dangerous-error rules, staged stops and resource ceilings. Unresolved model, prompt, memory and runtime hashes are explicit freeze prerequisites, not backfilled after holdout inspection. The registry uses `status: proposed` for the planned study; a dev-only sanity pilot is not a sealed result.

### Pre-run record and controlled hypotheses

For each proposed experiment, register an immutable ID and timestamp, question, directional hypothesis, one main changed factor, named comparator, fixed common inputs and tools, measurable endpoint with denominator, failure/falsification condition, budgets, and intended analysis slices. Record dataset manifest and content hashes, source rights and adjudication state, pinned base/model/recipe when applicable, SOP/runtime/solver versions, actual backend and fallback, prompt selection (`formal` or `bare`), approved knowledge snapshot, ontology, seed policy, and evaluation script revision. Record missing fields as unresolved; do not backfill a preregistration after viewing the holdout. Any new arm or threshold chosen after inspection is exploratory and needs a new sealed holdout to become confirmatory.

| Question | One changed factor and comparator | Falsification condition |
| --- | --- | --- |
| Does a memory route improve retrieval without changing answers? | One `memory.engine` or retrieval strategy versus a named baseline, with fixed SOP, facts, rules, reasoner and snapshot. | Evidence coverage, isolation, or correctness degrades under the predeclared case families; different storage costs are reported separately. |
| Does an external backend preserve the supported reasoning fragment? | `reference` JS versus the `prolog-tabling` strategy with explicitly selected SWI for point-in-time Horn, or Z3 for declared numeric constraints, with identical problem and evidence. | An admitted complete case disagrees on answer/projection or a required input disappears; unavailable binaries and incomplete results are exclusions, not a solver win. |

Register per-arm ceilings for wall time, CPU/GPU time, token usage, solver calls/timeouts, memory and disk **as actual study-specific quantities before execution**; no universal numeric compute budget is asserted here. State abort conditions, monitoring owner, maximum attempts, and whether an unavailable optional backend means skip rather than substitution. A changed model and a changed corpus are two experiments, not one confounded arm.

### Splits and locked evaluation

Assign the `semantic_case_id` group before rendering: paraphrases, EN/RO translations, hard negatives, shared source worlds and semantic duplicates stay in the same dev/test group, so no case of the development data is duplicated in a test. Reserve composition-family holdouts before generation; label seen-shape, structural, source-independent and external-reference tests separately. Never tune on sealed test cases, including via repeated prompt selection. Audit disjoint physical paths, group IDs, hashes, source rights, provenance and leakage; exclude source text not cleared in [DS011-source-rights.md](specsLoader.html?spec=DS011-source-rights.md) and non-independent reference cases from the study. Keep EN and RO denominators and each family/negative/UNKNOWN slice visible, including exclusions and confidence intervals where estimable; a synthetic fixture and a human-reviewed external case are not interchangeable.

### Reporting a result

Freeze the exact metric definitions, denominators and the pass/fail policy for incomplete or abstained results before evaluating; never improve a score by dropping failed cases, and treat abstention and nonresponse as incorrect for a required-answer denominator unless the frozen protocol designates a separate abstention endpoint. Publish counts, denominators, family/language slices, exact identities, invalid outputs, skips and actual backend routes. A failed or inconclusive hypothesis is retained as such. The promotion gates of the frozen small-formalizer branch are archived in `probably_obsolete/tinyLLMExperiments/specs/removed-sections-2026-10-02.md`.

### Planned study arms (PLANNED, not reported results)

The research question these arms test is stated in [DS000-vision.md](specsLoader.html?spec=DS000-vision.md). **PLANNED** specifies a proposed future study and does not itself authorize execution; nothing here is a measured outcome.

**PLANNED.** The source-to-knowledge study has five access-controlled conditions: **S0 source-only** uses the permitted source content without a reused implicit SOP library; **S1 dynamic repair** can propose, validate and apply a repair within the current task but does not carry it over; **S2 accumulating SOP** admits separately approved rules/procedures across eligible successive tasks; **S3 frozen library** uses a versioned snapshot with no new promotion during evaluation; **S4 teacher reference** measures what a qualified teacher produces under a declared access/cost regime, not a small-model oracle. Freeze the exact source access, external tools, proposal/promotion rules, temporal state, and candidate/accepted snapshots for each arm before comparing. A candidate rule, a quoted document or a model output never silently becomes global authority; counterexamples, independent source transfer and review are required before publication. **Decision 2026-09-28 (Q-ARCH-4):** S4 is out of the first experiment, which compares S0–S3 only. A later S4 arm first freezes here the teacher's permissions, model identity, knowledge access and monetary/token budget. Independent semantic adjudication of the EN/RO holdouts still needs a reviewer named by the owner, who reviews the sealed sets directly (the visual corpus audit belongs to the frozen branch, `probably_obsolete/tinyLLMExperiments/specs/DS020-corpus-audit-tool.md`); that is tracked in `TODO.md`.

**PLANNED.** Compare focused, bounded broad, adaptive and near-exhaustive expansion with measured call/time/token/memory budgets, stopping conditions, source order and cost to saturation. Measure per-family semantic accuracy and abstention, UNKNOWN calibration, semantic-gap recovery, cross-source transfer, approved-rule reuse, novelty and saturation; distinguish source gaps, formalization errors, missing semantics, solver failures and over-inference. Reuse is tested on different questions and independent sources rather than only the trigger that motivated a rule. Include longitudinal corrections, rarely used but important knowledge, fork/restart and forgetting. Report coverage and unsupported/partial routes beside accuracy.

**PLANNED.** Separate the *mechanism* study (same trusted circuit, knowledge and admitted route across memory/backend choices), the *formalization* study (new EN/RO messages into only the model-authored `stated`, `assumed`, `unclear`, `query` and `constraint` declarations), and the *complete agent* study (source-to-answer effects). Ablations vary KnowledgeLinker linking on/off, approved-procedure availability on/off, and CNL alone versus an optional verbalizer, one principal factor at a time. Memory comparisons include exact SQLite, RecallMemory, HoloMemory and verified hybrid hints at measured total budgets, with the per-strategy experiments listed in [DS016](specsLoader.html?spec=DS016-recall-memory.md)–[DS021](specsLoader.html?spec=DS021-memory-retention-and-generations.md); backend comparisons require the same supported semantics and the actual native route rather than fallback. A syntax pass, symbolic gold execution, repository smoke or historical test count is not conversational accuracy.

**PLANNED.** Further controlled studies mined from the archived requirements, each needing its own pre-run record: temporal-update robustness (late events, retractions, contradictory sources and `asof` questions; failure is a conclusion drawn from an expired or retracted premise); differential JS/SWI and JS/Z3 runs on the common profile, where any unexplained divergence is a defect; abduction utility (top-k inclusion of the confirmed cause, test cost, false hypotheses); induction transfer against a plain exact-counting baseline on held-out sources; use of newly approved procedures, testing selection and parameter binding rather than template copying; information preservation (answers from the original documents versus from the extracted facts). Every study reports the error locus (parser, representation, retrieval, reasoning, presentation) instead of a single score.

**PLANNED.** Baselines: small model in prose, small model writing SOP circuits, large model in prose, and large model with **the same approved knowledge and tools**; include inference/runtime costs. A comparison must not claim that a small agent beats an unassisted large model merely because one side alone received a library.

Every arm above is frozen with the pre-run record of this specification before any authorized run: directional hypothesis, one changed factor, comparator, falsification condition, source/case-group splits, provenance/rights, model and backend identities, hashes, library snapshot, seed policy, budgets, safety stops, metrics and denominators. Translations, paraphrases, shared source worlds and hard negatives stay grouped, and the holdout stays sealed from generation and from prompt or configuration selection. Paired uncertainty is reported at the independent case/source level, not as pseudo-replication of paraphrases, across seeds and sources, with exclusions, missing/invalid outputs, abstentions, confidence intervals where estimable, negative findings, incomparabilities and raw-result-derived tables.

### Publication route and evidence obligations (PLANNED)

**PLANNED.** An English architecture-and-mechanism paper maintains a claim→experiment→artifact→limitation ledger, distinguishes archived from fresh measurements, and explains its differences from PAL, LINC, Logic-LM, Scallop, LMQL, DSPy and RAG. The initial article may present reproducible **bounded** symbolic mechanisms with explicit missing neural evidence, never the superiority of a small agent. A separate, independently reviewed source-to-answer model study could support a later extended claim, but is not presumed successful. The archived Romanian v0.1 manuscript remains a historical draft, not a published manuscript. **Decision 2026-09-28 (Q-ARCH-3):** the system and the paper use the name ChatSOP; the English paper is the primary document and its first contribution is an architecture-and-method paper; nothing unclear is cited, so earlier experiments, historical figures and the unverified A1–A3 local archives are not cited unless they are reproduced or verified with owner, manifest, licence and immutable identifier.

**PLANNED.** Candidate outlets are not rankings, acceptance probabilities, submission commitments or validated policies: Neurosymbolic Artificial Intelligence (architecture with an executable artifact), NeSy (IR/linker/outputs/interpreters with controlled comparisons), Semantic Web (if formal representation, provenance, query interoperability and demonstrated tool maturity fit), JOSS (a later distinct software paper with actual public-development history and tests), and arXiv plus a versioned artifact (preprint dissemination, **not peer review**). Current venue scope, official calls, dates, format, disclosure, prior-publication, open-development and dual-submission rules are verified at the official links **immediately before** any submission. There are no simultaneous duplicate journal submissions.

**PLANNED.** Release only a stable, immutable version of code and compatible declared licenses, exact configurations/run identities, manifests and hashes, source rights and attribution, sealed-test rules, redistributable data **or lawful acquisition/reproduction instructions**, raw predictions and results, table-generation scripts, explicit backend/fallback/exclusion records and verifiable rerun instructions. A private conversation, unpinned external dependencies or a working archive is not a public reproducible artifact. Record actual author names and affiliations, funding and conflicts from the authors; disclose generative assistance and have authors actually review claims before any human-review declaration.

**Release checks.** Verify the SHA-256 manifest of a release before rerunning its tests; merge split verification groups only when they come from the same source and data version (`node tools/verify.mjs --collect` rejects stale or incomplete fingerprints); report optional external solvers and any GPU checks separately from the core result; and exclude personal state, tokens, keys, model weights and execution caches from the artifact. A network deployment additionally needs worker isolation per tenant, authentication, rate limiting, backups, crash, concurrency and restore tests, and version control of the ontology and compiler; none of these is provided by the local server of [DS009](specsLoader.html?spec=DS009-local-server.md).

**Observed rights boundary.** Rights findings are recorded per asset in [DS011-source-rights.md](specsLoader.html?spec=DS011-source-rights.md), not as blanket permissions. The inspired-by corpora derived from QQP, PAWS, ProofWriter, AmbigNQ, QA2D and SQuAD are released by the owner's decision of 2026-09-28 because they take no source text and pass the no-copy check; source text itself is published only where DS011 records it as cleared or permissive-attribution (for example SQuAD v2.0 under CC BY-SA 4.0 with its attribution, modification and ShareAlike duties). Romanian translations inherit source duties.
