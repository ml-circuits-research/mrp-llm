# MRP-LLM agent guidance

## Scope

This file is the root instruction file for changes to MRP-LLM. MRP-LLM builds small neurosymbolic language models: a **Model** is a base memory plus one strategy per pipeline slot (DS025); the symbolic core (formalization, SOP Lang, memories, reasoning, rendering) comes from ChatSOP and keeps its contracts (DS000 to DS023); the MRP layer (`lib/mrp/`, `server/mrp-routes.mjs`, `server/pages/models.mjs`, `config/profiles/`) runs the slots around it. Write all documentation, specifications, code comments, prompts and messages in English; conversation with the owner may be in Romanian.

## Mandatory Reading Order

1. `README.md`, then `docs/index.html` and the canonical terminology in `docs/wiki.html`.
2. `docs/specs/matrix.md`, then DS000 (vision), DS001 (coding style: module structure, tests, dependencies), DS002 (architecture), DS003 (main behavior), DS024 (SOP surfaces), DS025 (Models, slots, strategies), DS026 (language pipeline), DS027 (model gateway settings), DS028 (schemas, discovery, benchmark), and the core specifications a change touches.
3. The HTML documentation pages for the area being changed.

## Current Skill Catalog

The repository distributes the product skills under `skills/` (their catalog is `skills/README.md`); they are task procedures for the symbolic core, not runtimes.

## Repository Rules

- The DS specifications are the source of truth for documented behavior. When source code changes behavior, interfaces, architecture or workflows, update the affected DS files and the HTML documentation in the same change. DS numbering stays gap-free; `node tools/check-spec-refs.mjs` checks it.
- Design questions without a single right answer become slots or strategy parameters with a documented default (DS025), never a hardcoded choice. A new strategy is a catalog entry in `lib/mrp/strategies.mjs` (slot, id, parameters, cost, requirement), its implementation, its tests and its DS025 line.
- A strategy is never substituted silently: a strategy that cannot run is reported with its reason (DS025 "No silent substitution").
- Everything inside the pipeline is English; other languages are handled only by the `normalize` and `voice` slots (DS026). Lexemes, predicates, schemas and FAQ entries are English.
- Every model call goes through Ploinky Workers (`lib/pworker.mjs`, by tier and purpose); no file names a model endpoint (`tests/pworker/no-direct-model-calls.test.mjs`). Code and profiles name tiers, never concrete models. API keys never enter the repository, a response, a trace or a log (DS027).
- The `Ploinky-Worker` project is a separate repository used in place; fix and extend it there (with its tests: `npm test` in `../Ploinky-Worker`), never copy it here.
- The circuit-authoring boundary of the core holds (DS000, DS014): the formalizer writes only circuits; it never answers and never states facts. The language models of the MRP slots translate and phrase; they never answer.
- No hardcoded understanding: interpreting phrasings is the models' and the memory's job; deterministic code is for structure (parsing, normalising numbers and dates, rendering, similarity measures over normalized text). User-facing replies of the core live as SOP wires in base-memory layers.
- SOP Lang accepts the canonical and the compact surface (DS024); components write the canonical surface.
- Tests never call a real model: inject a fake client or transport. Run `npm test` (and `npm run verify` before a release); a change keeps the tests that passed green.
- DS rationale, limitations and boundaries are written declaratively in each DS's `Core Content`; there is no separate decision log.

## Runtime Defaults

Node.js 22.13 or newer, `.mjs` ES modules, explicit imports, `node:` built-ins, async/await, module-relative resources; the only npm dependency is `pworker` (`file:../Ploinky-Worker`), recorded in `dependencies.md`. DS001 is the full coding-style contract. `npm start` serves the site, the chat, `/models` and the OpenAI-compatible API on one port (`MRP_PORT`, default 9999). Runtime data (`chat_data/`, `state/`) is gitignored. Vendored reasoning engines (`reasoning/strategies/*/vendor/`, `eval/reference-engines/*/vendor/`) are copied verbatim from their source archives with a `VENDORED:` header.

## Key Paths

`lib/mrp/` (slots and strategy catalog, Models, the turn pipeline, similarity), `server/mrp-routes.mjs` (Models, strategies, model gateway routes), `server/pages/models.mjs` (`/models`), `config/profiles/` (Model profiles), `config/runtime.json` (`mrp` section, formalizer ladder), `config/knowledge/` (seed memories, including `acme-demo`), `sop/` (SOP Lang; `sop/compact.mjs` for the compact surface), `lib/` (formalizers, adapter, chat data, `lib/pworker.mjs`), `memory/`, `reasoning/`, `server/` (HTTP server, pages), `docs/` (HTML documentation, `docs/wiki.html`, `docs/specs/`), `tests/` (one folder per component; `tests/mrp/` for the MRP layer), `tools/`, `eval/`, `examples/`, `skills/`.
