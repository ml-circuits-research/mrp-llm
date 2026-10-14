---
title: DS016-recall-memory
summary: RecallMemory, the multi-view associative fact bank inspired by the column-voting idea of "A Thousand Brains" - mechanism, implementation status, contracts, legacy identifiers and the experiments still required.
---

## Introduction

RecallMemory is the default associative [memory engine](wiki.html#definition-memory-engine) of ChatSOP (`memory.engine: recall-memory`). It stores canonical SOP facts as overlapping projections in several independent hashed views and reconstructs candidate tuples by requiring every view to agree. The design is inspired by Jeff Hawkins' *A Thousand Brains*: many cortical columns each model the same object from a partial perspective, and their vote resolves ambiguity. RecallMemory borrows only that idea (several partial perspectives plus consensus). It is not a cortical model, does not learn reference frames or sensorimotor models like the Thousand Brains Project's learning modules (<https://docs.thousandbrains.org/docs/learning-modules>), and is not the whole intelligence of the agent. The strategy was identified by matching the code (`memory/weaver.mjs`: one view per column, a candidate survives only with support in every fully known view) against the archived design chapters that name the Thousand Brains inspiration; no other bank in `memory/` implements view voting.

The common bank interface, retrieval-strategy contract and completeness rules shared by all engines are in [DS005](specsLoader.html?spec=DS005-memory.md). Generations, retention and garbage collection are in [DS021](specsLoader.html?spec=DS021-memory-retention-and-generations.md).

## Core Content

### Mechanism

A fact is canonicalized to six fields: predicate with arity, up to four arguments (unused positions take a constant nil value) and polarity. Each **view** selects a subset of these fields and hashes the combination into its own bank; by default the views are all combinations of `arity` fields out of six (`arity: 3` gives 20 views), and a caller may supply up to 128 explicit views. Each bank has `2^power` cells (`power` 7–24) holding 4-bit saturating counters packed two per byte, so the counter arrays cost `views × 2^power / 2` bytes. Hashing is seeded per view, so the same fact addresses different cells in each view and different facts share cells.

- **Write** (`add`) increments the addressed cell of every view by the write strength (1–15, saturating at 15), records the argument values in per-predicate, per-position **domains**, and updates a SHA-256 **receipt** of the tuple with strength, observation count and last touch time. Re-observing a fact strengthens the same cells; there is no per-fact record in the counters.
- **Recall** binds each variable from the observed domain of its position (repeated variables intersect their domains), explores the smallest domain first, and prunes a branch as soon as any fully known view has an empty cell: the columns vote and one dissent rejects the candidate. A surviving tuple is returned only if its receipt exists (`verification: receipt`, the default); `verification: associative` disables the receipt filter for experiments. Blocked ids and expired receipts are skipped. `maxProbes` and `limit` bound the search, and exhausting either reports `complete: false`.
- **Reinforce** re-projects a fact actually used in a proof (the proof-use boundary is in [DS006](specsLoader.html?spec=DS006-reasoning.md)); retrieval alone never reinforces.
- **Decay** is one global cooling sweep: every counter and every receipt strength drops by the step, and receipts that reach zero are removed. **Maintain** in `adaptive` mode runs sweeps only when occupancy exceeds `safeOccupancy` and stops at `targetOccupancy` or `maxSweeps` (hysteresis). Occupancy is the fraction of nonzero cells, reported overall, per view and as the peak view; the peak view drives shard rotation in DS021.

The memory is "holographic" only in the operational sense that a fact is spread over many shared cells and survives partial loss gradually; it is multi-view hashing with counters, not a holographic reduced representation (for that family see HoloMemory, [DS017](specsLoader.html?spec=DS017-holo-memory.md)).

### Other uses of the same bank

The `associate` wire's associative mode builds a transient RecallMemory over explicitly supplied trace features (`reasoning/learning.mjs`) and scores a trace by the fraction of occupied projection cells. The score is a retrieval hint, never a proof or a probability, and the bank does not enumerate identifiers on its own.

### Implementation status (verified 2026-09-28)

| Capability | Status | Evidence |
| --- | --- | --- |
| Multi-view write, consensus recall, receipt filter, budgets | Implemented | `memory/weaver.mjs`; `tests/memory/memory-engines.test.mjs` (typed completion, negation, repeated variables, four arguments, budget truncation, snapshot/fork, blocked and expired tuples) |
| Cooling sweeps, pressure maintenance, receipt pruning | Implemented | `tests/memory/forgetting.test.mjs`; `tests/memory/repository.test.mjs` ("receipt checks are distinct from associative score", "pinned bank survives decay") |
| Use inside generations, promotion, routing | Implemented | `tests/memory/shards.test.mjs` (occupancy trigger uses the most occupied view, no splicing of tuples across shards) |
| Bank comparison with the other engines | Observed | [DS010](specsLoader.html?spec=DS010-engine-and-solver-comparison.md): 48/48 exact result sets at 64 and 256 atoms with 40,960 bank bytes at `power: 12`, rerun on 2026-09-28 |
| Learned view portfolio, cue indexing, pattern discovery from traces | Not implemented | Research items below |

### Contracts

1. A reconstructed candidate is not a proof, probability or independent fact; it becomes a proof premise only after receipt and claim-metadata verification by the temporal layer ([DS005](specsLoader.html?spec=DS005-memory.md)).
2. A receipt shows compatibility with an inserted tuple under the usual hash-collision assumption; it does not show that the claim is true or that the trace still survives decay.
3. `complete: true` covers the retained candidate space within the budget, never the history before forgetting and never the world.
4. Domains and receipts are exact metadata that grow with the data. Reports give `banksBytes` and `metadataBytes` separately; bank bytes alone are never presented as the total memory.
5. An existing bank cannot be resized in place, because the hash is masked by the bank size. Growth uses a new generation (DS021) or an explicit rebuild from an approved exact source.
6. Forgetting is approximate. It is not an exact LRU, never a retraction and never evidence of falsity.

### Identifiers

The canonical engine name is `recall-memory` and the matching retrieval strategy is `recall-memory`. The engine identifier `weaver`, the retrieval alias `recall-weaver`, the class alias `Weaver` and the file name `memory/weaver.mjs` are legacy identifiers of RecallMemory, kept so that existing configurations, snapshots and imports load. The `associate` wire still spells its RecallMemory mode `weaver`; renaming that wire value is a language change tracked in `TODO.md`.

### Experiments still required

None of the following has been run. Each needs a preregistered record under [DS007](specsLoader.html?spec=DS007-experiment-preregistration.md) and runs on CPU; none needs a model or a GPU.

1. **Retrieval value against exact storage.** Run the same approved suite with `recall-memory`, `exact`, `sqlite` and `hybrid`, holding schema, queries, reasoner and temporal policy fixed; report precision, coverage, latency and total memory including domains and receipts. Ablate the linker and retrieved procedures separately so the result is not credited to the views alone.
2. **View portfolio and geometry.** Sweep `power`, view arity and explicit or learned view sets; measure false candidates, probes and occupancy at the discrimination limit.
3. **Occupancy thresholds.** For each geometry, fill the bank progressively, measure recall, ambiguity and false positives on a held-out set, pick `safeOccupancy` before the point where quality drops fast and `targetOccupancy` low enough for hysteresis. The shipped values 0.55 and 0.42–0.45 are unvalidated defaults.
4. **Reverse and wide queries at scale.** Enumerating a large domain is costly; measure 10k–100k facts with varying values per key and popularity skew, then evaluate cue indexing, argument selectivity and hierarchical id recovery as candidate fixes.
5. **Damage and equal-byte robustness.** Erase a fraction of counters and compare recall and false acceptance with HoloMemory at equal total bytes (DS017).
6. **Trace-level regularities.** Store pre-semantic text traces and canonical SOP traces in separate banks and measure which regularities survive formalization; measure whether a mined pattern used as a retrieval hint raises exact recall without raising errors; whether similar-case priors improve abduction ranking; and what share of candidate patterns survive validation and promotion to reviewed rules. Patterns stay `pattern` or `hypothesis` until reviewed ([DS006](specsLoader.html?spec=DS006-reasoning.md), [DS013](specsLoader.html?spec=DS013-skill-systems.md)).
7. **Large-bank maintenance.** A sweep is linear in bank bytes; measure sweep cost for MB–GB banks and compare segment- or stripe-wise cooling with generational rotation (DS021).
