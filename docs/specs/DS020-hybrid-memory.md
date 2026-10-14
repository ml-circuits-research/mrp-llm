---
title: DS020-hybrid-memory
summary: The hybrid memory engine (exact SQLite evidence plus RecallMemory or HoloMemory hints), the `hybrid` and `auto` retrieval policies, the three-level memory architecture they approximate, implementation status and the experiments still required.
---

## Introduction

Exact storage and associative storage are good at different things. SQLite enumerates exact facts, rules and provenance and gives transactional control almost for free; an associative bank can complete partial patterns, measure familiarity and similarity, work in a fixed budget with gradual degradation and surface co-occurrences that nobody has named yet. The two are specialized, not competitors in every role. Hybrid memory keeps both without letting a hint become evidence. The shared bank interface is in [DS005](specsLoader.html?spec=DS005-memory.md).

## Core Content

### Two different `hybrid` settings

- **Physical engine** `memory.engine: hybrid` (`memory/banks/hybrid.mjs`, `probably_obsolete/config/runtime-hybrid.json`) writes every fact to an exact SQLite bank ([DS018](specsLoader.html?spec=DS018-sqlite-memory.md)) **and** to an associative bank selected by `memory.hybrid.associative`: `recall-memory` (default, [DS016](specsLoader.html?spec=DS016-recall-memory.md)) or `holo-memory` ([DS017](specsLoader.html?spec=DS017-holo-memory.md)); the legacy spellings `weaver` and `holo` are accepted. `recall` returns only exact rows, marked `verification: hybrid-exact`; `hints` returns the associative candidates separately. A failed or missing hint can never remove an exact answer, and a hint is never promoted to evidence. Decay and maintenance run on both banks; `bankBytes` and `stats()` report the sum and each part (`roles: exact evidence; associative hints only`).
- **Retrieval policy** `policy.retrievalStrategy: hybrid` (`memory/strategies.mjs`) is a search order over whatever the repository holds. If an exact representation exists (SQLite, scan or the exact sidecar of [DS019](specsLoader.html?spec=DS019-exact-reference-memory.md)), it searches exactly first and stops when that search is complete; otherwise it spends the **remaining** probe and shard budget on the associative route and merges rows by claim id, reporting `coverage: hybrid-retained-view`. Without any exact representation it behaves like `auto`. The default `config/runtime.json` uses this policy.
- **`auto`** reads whichever engines the visible generations were written with, through the common contract, and reports the engines it used. It never converts banks. An engine-specific strategy (`recall-memory`, `holo-memory`, `sqlite`, `scan`) refuses a snapshot written by another engine rather than producing a false comparison.

Neither setting chooses a reasoning solver ([DS006](specsLoader.html?spec=DS006-reasoning.md)).

### Three-level architecture

Hybrid memory is the implemented core of a larger design with three levels:

| Level | Responsibility | Status |
| --- | --- | --- |
| Experience and traces | Text, events, sequences, SOP fragments and usage traces rich enough to keep regularities not yet formalized | Not implemented as a store; `associate` and `induce` work only on explicitly supplied traces |
| Exact semantic knowledge | Facts, events, rules, procedures, ontology, aliases, time and provenance | Implemented (exact banks, temporal layers, reviewed library) |
| Semantic execution | SOP circuits, linker and interpreters that build and solve the relevant subproblem | Implemented ([DS004](specsLoader.html?spec=DS004-sop.md), [DS006](specsLoader.html?spec=DS006-reasoning.md)) |

Formalizing every experience immediately into SOP and keeping only the result is ideal for querying and deduction but can lose regularities that two very different situations share once both reduce to the same fact. Conversely, using an associative bank as the main store of facts, rules and provenance loses exact enumeration and transactional control. A mined regularity therefore enters the system only as a `pattern` or `hypothesis` that can guide retrieval, rank abductive explanations, select an existing procedure or propose a candidate rule for validation ([DS013](specsLoader.html?spec=DS013-skill-systems.md)); a frequent sequence "A then B" is never read as "A causes B".

**Decision 2026-09-28 (Q-ARCH-2).** The owner asked that every still-valuable memory idea from the archive be carried by specialized specifications, with the experiments it still needs, even where nothing is implemented yet. A long-term store of original source text and pre-semantic traces is therefore a planned component: it may hold only source text that [DS011](specsLoader.html?spec=DS011-source-rights.md) records as cleared or permissive-attribution, keeps the source hash, link and quote beside each formalized fact so that later re-formalization stays possible, and never becomes evidence by itself.

### Implementation status (verified 2026-09-28)

| Capability | Status | Evidence |
| --- | --- | --- |
| Exact-only answers with separate hints; hint bank selection | Implemented | `tests/reasoning/reasoning-v3.test.mjs` ("hybrid memory is independent from reasoning strategy"); `tests/memory/memory-engines.test.mjs` (legacy hint-bank names); lifecycle runs of [DS010](specsLoader.html?spec=DS010-engine-and-solver-comparison.md) |
| `hybrid` and `auto` policies across generations | Implemented | `tests/memory/shards.test.mjs`; `tests/memory/linker.test.mjs` |
| Hint benefit | Not shown | [DS010](specsLoader.html?spec=DS010-engine-and-solver-comparison.md): all 384 hint candidates per run matched exact rows and changed no top answer (rerun 2026-09-28), a negative result on a small corpus |
| Trace store, pattern mining inside memory | Not implemented | Experiments below |

### Experiments still required

Each needs a preregistered record under [DS007](specsLoader.html?spec=DS007-experiment-preregistration.md); none needs a model or a GPU.

1. **Hint benefit where exact search is incomplete.** Build suites where the exact route is truncated by budget or lacks a body, and measure whether associative hints raise correct coverage without adding false premises; report the extra work.
2. **Hints as ranking priors.** Measure whether hint membership improves the ordering of exact candidates, abductive explanations or procedure selection.
3. **Hint bank choice.** Compare RecallMemory and HoloMemory as hint banks at equal total bytes.
4. **Trace store.** After a rights-cleared corpus exists, compare text traces with SOP traces for the regularities each preserves, and answers from the original documents with answers from the extracted facts.
