# Job library (inherited from ChatSOP)

**Status (2026-10-14).** These folders come from ChatSOP, where they ran as job folders, task templates and TaskLambdas of the Ploinky Workers server (`pworker job`, `pworker call`, `pworker lambdas`). Ploinky Workers has since removed those execution surfaces: `/v1/jobs`, `/v1/lambdas`, `/v1/run` and `/v1/calls` answer HTTP 410, and the only task format is the declarative phase map (`Ploinky-Worker/docs/task-format-migration.md`). The commands below therefore no longer run. What stays in use is the code these folders hold: the harnesses under `tools/eval/` import the checks, sinks and prompts of `smalltalk-judge`, `smalltalk-replies`, `formalization-improve`, `books-triage` and `plugins/` as ordinary modules and call the models through the Ploinky proxy.

New model work of MRP-LLM is written as Ploinky phase maps in Markdown under `config/tasks/` and run in process by `lib/mrp/tasks.mjs` (DS025 "Prompts as Ploinky tasks"): model phases go through the caller's Ploinky client (its purpose, run and priority tags), local phases run in Ploinky's sandbox, and what the sandbox cannot do (the SOP validator, the memory) stays in this process between tasks.

## What the folders hold

- Job folders (`job.json`, `prompt.md`, checks): `formalization-improve` (the tier good proposes learned-layer wires for one failure cluster of the regression baseline; `checks.mjs` validates them, `sink.mjs` runs the tiny regression gate), `books-direct-calibration` (direct answers to 20 book problems scored by `checks.mjs`), `books-triage`, `smalltalk-judge`, `smalltalk-replies`.
- `templates/`: `ingest-document` (adapter over `lib/ingest`), `bulk-review` (adapter over `lib/llm-review`), `extract-table`, `label-entities`.
- `plugins/`: `sop-check.mjs` (knowledge validator and quote check), `sop-sink.mjs` (store circuits in a base memory or a session).
- `lambdas/`: the former TaskLambda modules (`chatsop.mjs`, `regression.mjs`); their functions are libraries of the harnesses.

Jobs name tiers or roles, never concrete models.
