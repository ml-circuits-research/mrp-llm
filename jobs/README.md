# ChatSOP job library

LLM batch work of ChatSOP runs through Ploinky Workers (manual: `Ploinky-Worker/README.md`): job folders, task templates and project TaskLambdas run as operations of the Ploinky Workers server (each call in an audited call folder), which calls the models by tier, enforces the run budgets and the priority classes, and caches responses. Ploinky Workers knows nothing about circuits; this folder holds ChatSOP's part, named by the configuration layer `the Ploinky user configuration (~/.pworker/config.json)` (section `runner`: run folders under `state/llm-jobs/` (gitignored), the template folder, model roles and task limits; section `lambdas`, old name `skills`: the project TaskLambdas and the job folders offered as TaskLambdas).

- Jobs: one folder each (`job.json`, `prompt.md`, plugins). `pworker job jobs/<job>`; `pworker check jobs/<job>` first, `--stage pilot` for the small stage. Jobs name tiers or roles, never concrete models; recurring work that can wait sets `"priority": "background"`.
  - `formalization-improve`: the formalization improver's loop: the tier good proposes learned-layer wires for one failure cluster of the regression baseline; `checks.mjs` validates them, `sink.mjs` runs the tiny regression gate and admits only what fixes cases and loses none (docs/runtime.html "Improving the step-by-step formalization").
  - `books-direct-calibration`: the worker tier answers 20 book problems directly; `checks.mjs` scores against gold (never in the prompt).
- `templates/`: what the planner of a task may choose (`pworker task --instructions ... --attach ... --target memory:<id>`): `ingest-document` (adapter over `lib/ingest`), `bulk-review` (adapter over `lib/llm-review`), `extract-table`, `label-entities`. Every template is also a skill.
- `plugins/`: `sop-check.mjs` (knowledge validator and quote check), `sop-sink.mjs` (store circuits in a base memory or a session).
- `skills/`: ChatSOP's project TaskLambdas, modules that add SOP-aware TaskLambdas to Ploinky Workers, each with its params and effects (`pworker lambdas --server` lists every TaskLambda; `pworker call <name> --params '{...}'` calls one; `pworker calls tree <id>` shows what a call did).

Read only a run's `summary.md` and `escalations.jsonl`; never loop over model calls by hand.
