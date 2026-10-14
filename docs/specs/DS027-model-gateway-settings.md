---
title: DS027-model-gateway-settings
summary: Every model call goes through Ploinky Workers by tier name; how MRP-LLM uses the proxy, how providers, API keys and tiers are configured from /models, what is stored where, and the thinking switch.
---

## Introduction

MRP-LLM never calls a model API itself. Every model call (normalize, reflex judge, affect, the formalizer's questions, round trip, voice, authoring) goes through **Ploinky Workers** (`pworker`), the sibling project `Ploinky-Worker`, installed as the npm dependency `pworker` (`file:../Ploinky-Worker`). Code asks for a **tier** (`tiny`, `small`, `fast`, …) and a purpose; Ploinky maps the tier to an ordered chain of provider and model, applies rate limits, caches responses and keeps the request log. `lib/pworker.mjs` is the project's only access point; `tests/pworker/no-direct-model-calls.test.mjs` enforces that no other file names a model endpoint.

## Core Content

### The proxy

One proxy serves one Pworker home (`~/.pworker`, or `PWORKER_HOME`) at `http://127.0.0.1:18080` (`PWORKER_URL`, `PWORKER_PORT`). A client starts it when none answers, except under `node --test`. MRP-LLM ships no Ploinky project layer: tiers and keys belong to the user's home, so every program on the machine shares one mapping and one set of rate limits. `tierReadiness(tier)` reports whether the proxy serves a tier and why not, without starting anything; the strategy catalog uses it for availability (DS025).

### Configuration from /models

The *Model gateway* tab of `/models` and the routes `GET /v1/mrp/pworker`, `PUT /v1/mrp/pworker/providers/{name}/key`, `POST /v1/mrp/pworker/providers`, `GET /v1/mrp/pworker/providers/{name}/models`, `PUT|DELETE /v1/mrp/pworker/tiers/{tier}` and `POST /v1/mrp/pworker/restart` configure the home. They require the administrator session (the signed-in browser); a bearer token gets 403. They call the Ploinky administration library `pworker/admin` (`Ploinky-Worker/lib/pworker/admin.mjs`), which the `pworker` CLI uses too.

### Seeing the real models

`GET /v1/mrp/tiers` is the read-only view of the tiers for every authenticated user: per tier, the configured chain (provider, model, thinking off) and what the running proxy serves now (the first usable entry and the fallbacks, or the reason a tier cannot be served). It never includes a key. The chat's *Symbolic Models* tab and `/models` use it to show the real model behind every tier a Symbolic Model uses (DS025 "Symbolic Model and tier").

### API keys

A key is set per provider (the built-in `openference`, `openrouter`, `deepseek`, `openai`, `zai`, `grok`, or a custom OpenAI-compatible provider added with endpoint, optional key and requests per minute). Before it is saved, the provider's live model catalog is requested with the key; a key the provider refuses is not saved. The key is written only to `<home>/keys/<provider>.env` (mode 0600), keeping the file's other variables; the configuration stores only the variable name. No route, page, trace or log returns a key: the listing says only whether a key is configured. An empty key removes it. Local models (llama-server providers with a `start` block) take no key and are started by the proxy on demand.

### Tiers

A tier is an ordered chain of `{provider, model, extraBody?, timeoutMs?}` or the name of another tier; the first entry whose provider is usable serves and the others are fallbacks. Tier changes are written to the user layer `<home>/config.json`; removing a tier override restores the built-in default. The model of an entry is chosen from the provider's live catalog. The proxy reads keys and tiers when it starts, so the page restarts it after a change; the listing shows, per tier, what the running proxy serves now. Strategies and profiles name tiers, never models.

### Reasoning settings

Reasoning ("thinking") models spend tokens before they answer; the formalizer's questions allow only a few tokens, so a model that reasons inside that budget returns nothing (`budget_exhausted`). How a model reasons is a property of the provider and model, so it is set on the **tier entry** in Ploinky Workers, never in MRP-LLM's requests: `extraBody` sends provider fields with every request of that entry and `minTokens` raises a smaller `max_tokens` to a floor. DeepSeek flash and most GLM servers accept thinking off (`thinking: {type: "disabled"}`, or `chat_template_kwargs: {enable_thinking: false}` on vLLM servers). z.ai `glm-5.3-flash` always reasons and refuses thinking off (error 1210, and on its coding endpoint it answers empty about four times in ten); it is used with `reasoning_effort: "low"` and `minTokens: 512`, which answered every probe with a few tokens of reasoning. The *Model gateway* tab sets these with the *Reasoning* choice (provider default, thinking off, low reasoning effort) and *min tokens* of every tier entry; `GET /v1/mrp/tiers` and the *Symbolic Models* tab show them. MRP-LLM's own requests carry no reasoning field (`mrp.extraBody` stays available for a deployment that needs one).

### The fast tier

The demo profiles (`acme-demo`, `general`) name the tier `fast` for their model calls. On a machine where it is configured (for example z.ai glm-5.3-flash with a low reasoning effort and a 512-token floor: a turn of `acme-demo` takes 20 to 40 seconds; DeepSeek flash with thinking off takes about 7), the slots run; where it is not, those slots report the tier as unavailable and the Model's owner either configures `fast` on the *Model gateway* tab or chooses another tier in the slots.
