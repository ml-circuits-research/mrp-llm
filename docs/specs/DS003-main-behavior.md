---
title: DS003-main-behavior
summary: The accepted user-impacting behaviors of MRP-LLM: talking to a Model in any language through its configured pipeline, configuring Models and the model gateway, and the behaviors of the symbolic core, including the canonical CLI command list.
---

## Introduction

MRP-LLM lets a user or an API client talk to a Model: a knowledge base plus one strategy per pipeline slot. The message is turned into English, typed [SOP](wiki.html#definition-sop) circuits are written and executed against reviewed knowledge by the symbolic core, and the checked answer is phrased in the user's language. The components below describe what the chat user, the Model owner, the operator and the integrator can observe; lower-level semantics belong to the specialized specifications.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Talk to a Model in any language | A chat user or API client names a Model; its normalize, reflex, core, round-trip and voice slots answer in the user's language from computed results, with a trace per slot. |
| Configure Models and the model gateway | A Model owner chooses one strategy per slot, the FAQ, the language and the commit policy on /models; an administrator sets provider API keys and tiers of Ploinky Workers there. |
| Execute typed SOP circuits | A CLI user submits a circuit and receives a validated result, evidence, or a precise rejection. |
| Translate local conversation into checked SOP answers | ChatSOPAdapter answers every message in a configurable mode: the step-by-step formalizer (the default), routed formalizations that verify each other by agreement, or a direct model answer that the formalizations try to verify; every answer states how it was obtained and whether it was verified. |
| Publish reviewed knowledge | An operator admits sourced facts and approved definitions, while model and document text cannot publish them. |
| Preserve isolated temporal knowledge | Users and sessions query and update knowledge with independent temporal history and fork boundaries. |
| Substitute memory and reasoning independently | Integrators change physical memory and reasoning routes without changing the SOP program's meaning. |
| Follow project work and evaluation | An administrator reads the project journal, preregistered experiments and evaluation reports through the local server pages. |

### Talk to a Model in any language

A chat user on `/chat` (choosing the Model and the answer language under *Settings*) or an API client calling `POST /v1/chat/completions` with `model` set to a Model id (listed by `GET /v1/models`) sends one message per turn. The Model's `normalize` slot turns the message into clean English and detects its language; the `reflex` slot may answer at once from the Model's FAQ; otherwise the symbolic core formalizes the English text, validates, links, retrieves, reasons, verifies and renders a deterministic English answer; the `roundtrip` slot may restate the circuit and compare it with the message; the `voice` slot phrases the answer in the output language (the request's `metadata.language`, the session's `language`, or the Model's, `auto` meaning the message's language); the `commit` slot decides what happens to session definitions. The response carries the answer, the English answer, and `mrp` with the Model, the languages and one trace entry per slot. The hidden consequence is that the computed answer does not depend on the user's language. A Model whose slot names a strategy this server cannot run is refused with 503 `strategy_unavailable`; no strategy is replaced silently. See [DS025](specsLoader.html?spec=DS025-models-slots-and-strategies.md) and [DS026](specsLoader.html?spec=DS026-language-pipeline.md).

### Configure Models and the model gateway

A Model owner opens `/models` (or uses `/v1/mrp/models`) to create a Model from a profile, choose its base memory, its answer language, one strategy and its parameters per slot, its FAQ, and whether sessions and requests may override slots; what the Model learned (the reflex boundary of `faq-feedback`) and its review queue (`review-queue` commit policy) are shown and decided there. An administrator signed in on the browser uses the *Model gateway* tab to set or remove provider API keys (validated against the provider's catalog, stored only in the Pworker home, never shown again), add OpenAI-compatible providers, edit tier chains with the thinking switch, and restart the Ploinky proxy. See [DS025](specsLoader.html?spec=DS025-models-slots-and-strategies.md) and [DS027](specsLoader.html?spec=DS027-model-gateway-settings.md).

### Execute typed SOP circuits

A CLI user invokes `node server/cli.mjs run --file <path>` to execute a typed SOP circuit, written in the canonical or the compact surface ([DS024](specsLoader.html?spec=DS024-sop-surfaces.md)); `validate --file <path>` checks and canonically prints a program, while `compile-smt` and `compile-prolog` export their supported typed subsets. The parser, scheduler, [linker](wiki.html#definition-linker), reasoner, and [CNL](wiki.html#definition-cnl) output make the result and its evidence visible. `@id` declares a wire, `$id` consumes its value, `~id` identifies a definition, and `?x` denotes a local logical unknown; result output can bind a generated wire after solving. Invalid fields, unresolved dependencies, and unauthorized effects cannot be treated as successful execution. See [DS004](specsLoader.html?spec=DS004-sop.md).

### Translate local conversation into checked SOP answers

A local CLI user invokes `chat`, which runs the product chain (the query author, validation, linking, execution) to ask a question or supply context. The formalizer is step by step (owner decision 2026-10-02): the system asks short questions about the user's message and the vocabulary of the memory, a Ploinky Workers tier answers them (the ladder `tiny`, `small`, `good`, escalated per question only when an answer cannot be read), and the system assembles only circuits: `query` and `constraint` wires, `unclear` and `unparsed` reports and `stated` suppositions of the message; `assumed` session definitions and assumptions are planned ([DS014](specsLoader.html?spec=DS014-model-surface.md)). The answering model never writes SOP, an answer or a fact, and a statement or assumption is a turn-local string report, not a sourced user assertion or a repository write. The validator admits the circuit or the strategy re-asks the doubtful question in bounded rounds; a separate layer links the strings to the memory and compiles an inspectable circuit for identity lookup, reasoning and rendering. When identity is missing or ambiguous or a required scalar is missing or nonunique, symbolic orchestration generates a `clarify` wire and suspends dependent work; lack of supporting knowledge by itself is not a request for user clarification. The [agent](wiki.html#definition-agent) checks the circuit and permitted actions, runs it, and returns a deterministic English controlled-language answer; no model verbalizer is called. When the first tier of the ladder is not available the turn is answered with an honest `parse_unavailable`; no other parser runs. An execution metaprogram cannot guess ambiguous identity, promote statements or assumptions into stored facts, or infer publication authority. Explicit sourced `fact` and `remember` remain available to trusted runtime and tool callers separately from model-origin circuits. The local server exposes the same agent through an OpenAI-compatible chat façade ([DS009](specsLoader.html?spec=DS009-local-server.md)).

The chat, the API and every evaluation answer through one module, ChatSOPAdapter (`lib/adapter`, owner decision 2026-10-03), so a number measured offline is the behaviour of the chat. Its mode is set in `config/runtime.json` `adapter.mode`, per session (`adapter_mode`) or per request (`adapter: {mode, options}`):

| Mode | Behaviour | Verification status |
| --- | --- | --- |
| `stepwise` (default) | The step-by-step formalizer writes the circuit and the session's chat turn executes it, as described above. | `unverified` (one formalization); the oracle check of the routed answer stays in `route.verification`. |
| `routed` | The structure role marks the problem's spans; a deterministic route sends a problem whose goal is computed from given quantities to compute path B, with jsEval and engineCode (JavaScript and SMT-LIB by default) as second formalizations, and every other problem to FOL v2. Each formalization executes on the engines, behind the static data-dependency check; FOL's unsafe closed-world answers are withheld. | `verified` when two different formalizations give the same answers, `unverified` for a single answering path, `unresolved` when they disagree (the primary path answers and the others are reported) or nothing answers. |
| `direct-verified` | The direct tier answers with a short `FINAL ANSWER`; the routed formalizations then try to verify it, compared with the symbolic answer-equivalence catalog. | `verified` when a symbolic path gives an equivalent answer, `contradicted` when two symbolic paths agree on another value (that value is answered and the model's is reported), otherwise `unverified` with the model's answer labelled as such. |

In the modes `routed` and `direct-verified` a message is a self-contained problem: nothing of it is written to the session's memory. The result packet names the mode, the answering path (`stepwise`, `B`, `jsEval`, `engineCode:<language>`, `fol`, `direct`), the verification status with the agreeing paths, the circuits and proofs of the answering path, the time of each stage and the Ploinky Workers tier of each role. The reply states the verification status through reply wires of the conversation layer; the code holds no phrasing.

### Publish reviewed knowledge

An operator publishes reviewed facts and executable definitions through authorized ingestion, with quoted sources and hashes when required. Source documents and model suggestions may provide proposals, but neither can install a rule, policy, procedure, or ontology update through generated text alone. A published claim retains its provenance and validity conditions; approval is not a claim that a source is infallible. See [DS004](specsLoader.html?spec=DS004-sop.md) and [DS005](specsLoader.html?spec=DS005-memory.md).

### Preserve isolated temporal knowledge

A CLI user or operator uses `init`, `fork`, `commit`, `discard`, `stats`, `maintain`, and `gc` to manage reviewed knowledge and private changes. The [repository](wiki.html#definition-repository) keeps users, sessions, and forks separate, distinguishes time a claim is valid from when it became known, and preserves corrections, retractions, and referenced snapshots. `gc` reports candidates without `--apply`; applying it must not discard snapshots still referenced by users, sessions, or forks. A missing retrieved fact is not proof of negation, and retention can affect answer completeness. See [DS005](specsLoader.html?spec=DS005-memory.md).

### Substitute memory and reasoning independently

An integrator selects `memory.engine` and `policy.reasoningStrategy` independently in a runtime configuration and executes the same SOP against the selected providers. Exact or associative retrieval changes completeness and cost, while the reference strategy (the `js-reference` oracle) has a supported reasoning domain; a wire that names an external backend maps to that backend's strategy id or returns `unsupported` with the backend named and `fallback: null` (rule 8). The observable route and fallback must be reported: a JavaScript result is never a Prolog or Z3 run, and an approximate retrieval score is not probability or proof. See [DS005](specsLoader.html?spec=DS005-memory.md) and [DS006](specsLoader.html?spec=DS006-reasoning.md).

### CLI commands

This section is the canonical command list; `docs/runtime.html` links here instead of repeating it. `node server/cli.mjs help` prints the same list.

| Command | Effect |
| --- | --- |
| `init [--base demo]` | Publishes the reviewed bootstrap fixture (`tests/fixtures/bootstrap.sop`) as a base snapshot. |
| `run --file <path> [--base --user --session --now --json]` | Executes a typed SOP circuit against the selected session. |
| `validate --file <path>` | Parses, validates and canonically prints a program without executing it. |
| `compile-smt --file <path>`, `compile-prolog --file <path>` | Export the supported typed subset of a constraint or Horn program. |
| `lexicon --text <text>` | Prints the lexicon candidates for a text; linking support for inspection. |
| `chat [--cnl-only]` | Interactive local conversation through the product chain (query author, validator, linking, execution); the answer is the deterministic controlled-language text. It needs the first tier of the formalizer's ladder. |
| `fork --from <base> --to <base>`, `checkpoint-base` | Repository fork and base checkpoint. |
| `commit`, `discard`, `stats`, `maintain`, `migrate`, `close-session`, `decay --steps <n>` | Session lifecycle, retention maintenance and statistics. |
| `gc [--apply]` | Reports unreferenced snapshots; deletes them only with `--apply`. |

### Follow project work and evaluation

`npm start` serves the local site (default `0.0.0.0:9999`). After administrator sign-in, `/eval` browses sealed suites, predictions and current reports with the evaluation guide at `/eval/guide`, and `/experiments` shows the append-only journal `status/journal.jsonl` and the preregistered experiments of `status/experiments.json` ([DS007](specsLoader.html?spec=DS007-experiment-preregistration.md)). These pages read existing artifacts; they never train a model, and a journal entry or report is a record of work, not a current measurement unless it says so. See [DS009](specsLoader.html?spec=DS009-local-server.md).
