---
title: DS026-language-pipeline
summary: English is the only internal language; a model translates and cleans the message at the start and phrases the answer in the output language at the end; how the output language is chosen and which guarantees the two language steps keep.
---

## Introduction

Every symbolic part of MRP-LLM works in English: predicates, lexemes, schemas, the formalizer's questions, the FAQ, the rendered answer, the indexes and the benchmarks. Other languages are handled only at the two edges of a turn, each by a model reached through Ploinky Workers (DS027): the `normalize` slot turns the user's message into clean English, and the `voice` slot phrases the English answer in the output language. No lexeme, predicate or schema is bilingual, and no component outside these two slots reads or writes another language. The slots and their strategies are defined in DS025; this specification fixes the language contract they serve.

## Core Content

### Inbound: normalize

The `normalize` slot returns the message in English and the ISO 639-1 code of the message's language. With `translate-llm` (the default) one model call returns a JSON object `{language, english, changed}`: the message translated faithfully, spelling and grammar fixed, and (parameter `formalize`) casual, elliptical or garbled wording made explicit and plain. The prompt forbids answering, adding or removing content, and requires names, numbers, dates, quantities, codes and quoted text to be kept exactly. `translate-if-foreign` calls the model only when a message does not read as English; `proofread-llm` keeps the wording of an English message; `passthrough` uses the message as typed. With the parameter `context` (`translate-llm` and `proofread-llm`, default 4) the previous turns of the session (the user's turns in their English form, the assistant's replies) are shown before the message, and the model rewrites the message so that it is self-contained: it resolves pronouns and ellipsis and restates the values and facts the user gave earlier that the message relies on ("What is MY_VAR?" after "Remember that MY_VAR is 100" becomes "Given that MY_VAR is 100, what is MY_VAR?"); the assistant's replies are context, never facts. Each turn of the core therefore reads one self-contained English message, which is how what the user stated earlier in a conversation reaches the formalizer. The original message is kept in the trace (`mrp.original`), in the session transcript (`text`, with the English in `english`) and is shown to the voice step. When the model fails or returns no readable JSON the original message is used and the trace says why.

### Inside: English only

The formalizer, the vocabulary, the validator, the linker, retrieval, reasoning, verification and rendering receive the English text. `sop/answer-text.mjs` renders the deterministic English answer, which is always kept in `chatSop.english_text`. Value schemas, lexemes and FAQ entries are written in English; corpus ingestion and schema discovery (DS028) work on English text, a document in another language being translated before it is ingested. Benchmarks measure each slot on English input, and the language edges are measured separately.

### Output language

The output language of a turn is, from the most specific: the request's `metadata.language`, the session setting `language`, the Model's `language.output`. Session and request choices apply when the Model allows overrides (DS025). The value is a language code (`en`, `ro`, `fr`, …) or `auto`, which means the language `normalize` detected in the message; when no language could be detected, the voice is asked for the language of the user's message. The chat page offers the choice under *Settings → Answer language*; the API takes it per request or per session.

### Outbound: voice

The `voice` slot turns the English answer into the reply. `natural-rephrase` (the default) rewrites it as a short natural reply in the output language; `translate-only` translates it faithfully and makes no call when the output is English; `english-only` returns the English answer. The voice may use only the English answer and a compact copy of the result packet (status, answers, count, facts used and their sources); it adds no fact, opinion or knowledge of its own. Every number and source id of the English answer must appear in the reply (for a natural English rephrasing: the numbers and names of the answer line), otherwise the English answer is shown and the trace says what was dropped. An affect label of at least 0.4 intensity (`affect` slot) adds one sentence of tone guidance to the voice prompt; it never changes the content. A reflex answer (an FAQ entry) goes through the same voice step.

### Guarantees

The computed answer is language-independent: the same English text gives the same circuit and the same result whatever the user's language. A failure at either edge never produces a wrong answer: the inbound edge falls back to the original message, the outbound edge to the deterministic English answer. Both edges are recorded in `mrp.trace` with their strategy, model, duration and outcome.
