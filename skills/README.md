# Coding-agent skills

These files describe working procedures, not automatically loaded executable plugins. Read `AGENTS.md` and then the relevant skill. No model is trained in this project, and no skill trains one. Open owner decisions go to the root `questions.md`. The project directory remains the workspace; source and code approvals are separate decisions.

**Project journal.** Every skill that starts, finishes or blocks a meaningful task, or records an owner decision, logs it with `node tools/journal.mjs add --area … --title … --detail …` into the append-only `status/journal.jsonl`; experiment records go to `status/experiments.json`. Meaningful analyses, suggestions, results and decisions are also appended as topic notes with `node tools/notes.mjs add --topic … --kind … --title … --body …` (append-only; corrections use `--supersedes`). The owner follows all of it on the server's `/experiments` pages. The evaluate-agent skill states this explicitly.

## Procedural skills (with `SKILL.md`)

**coding-agent-query** (archived 2026-10-02) — the guide of the one-shot author LLMDirect, which wrote whole SOP query circuits; formalization is now step by step (DS022 "Formalization strategies"). Kept for history in `probably_obsolete/one-shot-formalization/skills/coding-agent-query/`.

**compare-memory** — Compare memory strategies without changing the semantic task.

**evaluate-agent** — Audit the complete experiment: circuits written by the coding agent, execution through the StrategyRouter, and the comparison with small LLMs (the symbolic-vs-LLM benchmark); counts, `not_computable`, `parse_unavailable` and `unsupported` kept apart.

**extend-reasoning** — Implement and compare a reasoning strategy.

**extend-wire** — Add a typed, approved SOP interpreter.

**ingest-sop** — Ingest documents into sourced SOP facts.

**link-circuit** — Review and compose an SOP circuit that the runtime can link.

**manage-shards** — Maintain local generations, retention, copy-on-write snapshots, migration and safe garbage collection.


**mine-patterns** — Generate and validate candidate patterns from traces.

**omp-run** — Run the omp coding agent non-interactively on a temporary folder: model discovery with a cost class (`GET /v1/omp/models`), the fence (cwd, read/write/edit tools only, no profile extensions or skills, secrets never in prompts), a timeout, cost read from the session files, and the validate-and-repair loop that turns attached files into draft SOP circuits with `sop-wire-authoring`; the output is unapproved proposals.

**procedure-library** — Build approved SOP rules and templates.

**reasoning-review** — Review epistemic objects and reasoning contracts.

**review-knowledge** — Review assertions and temporal corrections.

**sop-wire-authoring** — Compile a long text (a book, manual, regulation, article) into checked knowledge wires (predicate, fact, rule, default, aggregate, action, method, norm) for evaluations and memory: the write-validate-fix loop with `node eval/smoke-reasoning/validator.mjs --authoring`, source and quote rules, closedness only with a source sentence, reification, symbols versus strings, no `jsEval`, a differential check of two independent compilations (`scripts/compare-compilations.mjs`) and how to split long texts; its output is unapproved proposals. The sub-folder `programming/` holds `TASK.md`, the task of the programming path (programming plan, milestone P0): the coding agent turns an instruction for a small JavaScript function into `task.sop` (task facts and `test` wires) and `candidate.sop` (a `code` wire), which the host validates and runs in the `code-sandbox` strategy (`probably_obsolete/paused/lib/programming/solve-instruction.mjs`). The vocabulary of a base memory (`predicate`, `lexeme`, `entity`: classes, labels, lexemes, readings) has its own recipe, `skills/sop-wire-authoring/lexicon.md`.

## Code-only skill systems (no `SKILL.md`)

These folders hold executable modules specified by [DS013](../docs/specsLoader.html?spec=DS013-skill-systems.md) and exercised by `tests/reasoning/skill-systems.test.mjs`.

**failure-classifier** — `classify.mjs`: classifies observed failures.

**implicit-sop-registry** — `registry.mjs`: the authorized implicit-SOP registry.

**semantic-gap-resolver** — `resolve.mjs`: semantic-gap proposals with explicit exceptions.

## Frozen and retired skills

The skills of the tiny-model branch (`corpus-audit`, `lexicon-curation`, `night-orchestration`, `semantic-sop-review`, `spark-training`, `synthetic-sop-data`, `training-rules`, `training-runbook`) moved to `probably_obsolete/tinyLLMExperiments/skills/` on 2026-10-01. `data-quality` and `wire-discovery` were imported from a sibling project and moved to `probably_obsolete/skills/` on 2026-09-28.
