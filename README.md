# MRP-LLM

MRP-LLM (Meta Rational Pragmatics language models) builds **small neurosymbolic language models**, specialised by domain or by type of problem. A message is interpreted by a pragmatic interpreter (a formalizer) into SOP Lang circuits, knowledge lives in an explicit knowledge base, the answer is computed by symbolic reasoning engines and only *phrased* by a language model. Every answer can be traced back to the circuit that asked it and the facts that support it.

What a user or an API client talks to is a **Symbolic Model**: a base memory (facts, rules, procedures, schemas) plus one strategy per pipeline slot. Its steps that need a language model name a **tier** of Ploinky Workers (`tiny`, `small`, `fast`, …), and Ploinky Workers maps each tier to real provider models; the chat's *Symbolic Models* tab shows which real model is behind every tier a Symbolic Model uses. The pipeline is the same for every Model; how each slot works is a setting of the Model:

| Slot | What it does | Example strategies |
| --- | --- | --- |
| normalize | the message in clean English, with its language | translate-llm, translate-if-foreign, proofread-llm, passthrough |
| affect | emotion and urgency, for tone and for affect reflexes | lexicon, lexicon-then-llm, llm-label, formalizer-pragmatic, off |
| reflex | instant answers: pattern and affect reflexes, the Model's FAQ | faq-hybrid, faq-fixed, faq-margin, faq-feedback, faq-llm-judge, faq-llm-select, pattern-reflex, off |
| formalize | SOP circuits from the English text | DirectSOP, SchemaGuidedLLM, SchemaOrDirect, Ensemble, EnsembleOneShot, LocalLLMStepByStep, InternalReasoningStepByStep, Routed, DirectVerified |
| admit … render | validation, linking, retrieval, the symbolic engines, oracle verification, deterministic English answer | reason: strategy-router or a named engine; verify: oracle-js, oracle-always, cross-engine, off |
| roundtrip | restate the circuit and compare it with the message | on-doubt, judge-on-doubt, lexical-always, lexical-sampled, llm-judge, off |
| voice | the answer in the user's language, adding no fact | natural-rephrase, natural-if-foreign, translate-only, english-only |
| commit | what session knowledge does to the memory | manual, review-queue, auto-validated, never |
| discover | value schemas from a corpus | manual, llm-consolidate, term-stats and splade-stats (strategy service) |

The catalog (`GET /v1/mrp/strategies?check=1`, `/models`) also lists documented designs that are not implemented yet (SPLADE routing, SAE, dependency scaffolds, controlled English, graph retrieval) with the status `not-implemented`, apart from strategies that only miss a dependency. Prompts are Ploinky Workers tasks in Markdown under `config/tasks/`; value schemas (`schema`, `extractor`) and reflexes (`reflex`) are knowledge wires of a base memory. The strategies that need Python run in the strategy service (`python3 services/strategy-service/server.py`).

Everything inside works in English; a model translates at the start of a turn and phrases the answer at the end. Every model call goes through **Ploinky Workers** (`pworker`) by tier name. SOP Lang is accepted in two surfaces: canonical field lines and compact `@id type key=value` pairs.

The symbolic core (formalization, SOP Lang, memories, reasoning engines, the chat and the evaluation tooling) comes from ChatSOP. The design specifications are in [docs/specs](docs/specs/matrix.md); start with DS000, DS003 and DS025.

## Prerequisites

- Node.js 22.13 or newer (the built-in `node:sqlite` module is used).
- The sibling project `Ploinky-Worker` next to this folder (`../Ploinky-Worker`); it is installed as the dependency `pworker`.
- For answers from models: at least one provider key or local model configured in Ploinky Workers (see *Configure models* below). Symbolic circuits run without any model.
- Optional reasoning backends (SWI-Prolog, Z3, Soufflé, clingo) are used when installed; the JavaScript reference oracle needs nothing.

## Install

```sh
cd mrp-llm
npm install          # links ../Ploinky-Worker as node_modules/pworker
```

## Start

```sh
npm start                          # serves http://0.0.0.0:9999 and prints the URLs
MRP_HOST=127.0.0.1 MRP_PORT=9911 npm start
```

On the first start the seed memories are built (about a minute) and the Models of the first-start profiles are created (`acme-demo`, the default, and `general`). Open the printed home URL, choose the administrator password on the sign-in page, then:

- **Chat** (`/chat`): talk to a Symbolic Model. *Settings* chooses it and the answer language; the *Symbolic Models* tab lists the Symbolic Models with the tiers and real models they use, changes their tiers and creates new ones; every answer has a trace panel whose first section shows the MRP slots (English text, languages, reflex, round trip, voice).
- **Symbolic Models** (`/models`): edit Symbolic Models (base memory, language, one strategy and its parameters per slot, FAQ, overrides), see what a Model learned and approve its review queue; the *Model gateway* tab sets provider API keys, tier chains and restarts the Ploinky proxy.
- **Knowledge** (`/review`), **Admin** (`/admin`), **Docs** (`/docs/`).

Environment: `MRP_HOST`, `MRP_PORT`, `MRP_API_KEY` (a bearer token of at least 16 characters for scripts), `MRP_CONFIG` (another runtime configuration), `MRP_CHAT_DATA` (another data folder), `MRP_WARMUP=0`. The `CHATSOP_*` names of the core are accepted too.

## Configure models

Model calls name tiers (`tiny`, `small`, `fast`, …); Ploinky Workers maps each tier to a chain of provider and model. On `/models` → *Model gateway*:

1. Paste an API key for a provider (for example `deepseek` or `zai`); it is checked against the provider's model list and stored only in `~/.pworker/keys/<provider>.env`.
2. Edit a tier: choose provider and model from the live catalog, tick *thinking off* for cloud flash models, add fallbacks. The demo profiles use the tier `fast` (for example `deepseek-flash` with `glm-5.3-flash` as fallback, both with thinking off).
3. The proxy restarts with the new settings.

The same is available from the command line: `npx pworker provider …`, `npx pworker tier …` (see `../Ploinky-Worker/README.md`).

## Use the API

The API is OpenAI-compatible; `model` names a Model.

```sh
curl -H "Authorization: Bearer $MRP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"acme-demo","messages":[{"role":"user","content":"Cine lucrează la Acme?"}]}' \
  http://127.0.0.1:9999/v1/chat/completions
```

The answer comes in Romanian; `chatSop.english_text` holds the deterministic English answer and `mrp` the trace of the slots. `metadata: {"language": "fr"}` asks for another answer language and `metadata: {"slots": {...}}` overrides slots for one request when the Model allows it. Models and strategies: `GET /v1/models`, `GET /v1/mrp/strategies?check=1`, `GET|POST /v1/mrp/models`, `GET|PUT|DELETE /v1/mrp/models/{id}`. The full API is in [docs/api.html](docs/api.html).

## Run circuits without a model

```sh
node server/cli.mjs run --file examples/query.sop
node server/cli.mjs validate --file examples/query.sop
```

## Test

```sh
npm test          # node --test over tests/**/*.test.mjs
npm run verify    # tests, smoke reasoning, spec references, shard check, site links
```

Tests never call a real model: they inject fake transports, and a Ploinky client under `node --test` cannot reach the real proxy.
