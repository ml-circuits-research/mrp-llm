---
title: DS021-memory-retention-and-generations
summary: Memory organization strategies shared by all engines - nonsharded temporal layers with none or adaptive retention, generational shards in bounded or archive mode, proof-use promotion, the copy-on-write repository with sessions, forks and safe garbage collection, implementation status and the experiments still required.
---

## Introduction

Every memory engine ([DS016](specsLoader.html?spec=DS016-recall-memory.md)–[DS020](specsLoader.html?spec=DS020-hybrid-memory.md)) sits inside the same organization: a temporal layer or a set of generational shards that holds banks, exact claim metadata and correction events, stored in a local copy-on-write repository of bases, users and sessions. Forgetting is part of this organization, not of the SOP language, and it never changes what a claim means: weakening memory only reduces recoverability, while ending or retracting a claim is an exact semantic event ([DS005](specsLoader.html?spec=DS005-memory.md)).

## Core Content

### Nonsharded temporal layer

`memory/temporal.mjs` (`TemporalLayer`) keeps two physically separate banks, **normal** and **pinned**, plus exact claim metadata (id, tuple hash, interval, known time, source, quote, retention), end and retract events, an optional source journal (never read by recall) and the optional exact sidecar ([DS019](specsLoader.html?spec=DS019-exact-reference-memory.md)). A fact declared `retention pinned` goes only to the pinned bank, which automatic maintenance never cools; pinning is meant for explicit user instructions, safety rules and stable identities. Reobserving a normal claim as pinned promotes its retention.

`memory.retention` selects the policy:

- `mode: none` (archive; `probably_obsolete/config/runtime-archive.json`, `probably_obsolete/config/runtime-holo-memory.json`) performs no automatic decay; `safeOccupancy` is only an indicator, and the host must add capacity or generations before saturation.
- `mode: adaptive` (cache-like; `probably_obsolete/config/runtime-adaptive.json`, `probably_obsolete/config/runtime-associative.json`) adds `writeStrength` on a normal write and, after every normal write or proof use, runs maintenance: below `safeOccupancy` nothing happens; above it, cooling sweeps lower every normal counter and receipt strength by `decayStep` until occupancy is at or below `targetOccupancy` or `maxSweeps` is reached. With `pruneMetadata`, normal claims whose receipts disappeared are removed with their journal entries; retractions are never pruned. `writeStrength > 1` keeps a just-observed fact from vanishing in the first sweep. The defaults are `safeOccupancy 0.55`, `targetOccupancy 0.45`, `writeStrength 2`, `useStrength 1`, `decayStep 1`, `maxSweeps 15`.

A fact actually used in a real, non-hypothetical proof is re-projected with `useStrength` when `retention.reinforceOnUse` and `policy.reinforce` both permit it ([DS006](specsLoader.html?spec=DS006-reasoning.md)); merely retrieved candidates are never reinforced, because strengthening a false positive for being found would feed back into error. A useful fact from an older snapshot gets a minimal metadata copy in the current layer so that it can survive that snapshot. The `decay` command is an explicit test tool for this profile; `maintain` applies the configured policy and `--force` forces one adaptive cycle.

### Generational shards

`memory/sharded.mjs` (`ShardedLayer`, the default profile) splits memory into immutable **generations**. Each shard owns its bank, domains, receipts, claims, optional exact tuples and optional source journal; a hot normal shard and a hot pinned shard take new writes, and sealed shards become cold. Before a new claim is added, the hot shard is sealed when the **most occupied view** reaches `sharding.safeOccupancy` (not the average, which can hide a saturated view), when it holds `maxClaimsPerShard` claims, when its metadata exceeds `maxShardMetadataBytes`, or when it is older than `maxHotAgeMs`. Reobserving an existing claim does not rotate. A rotation threshold is not a hard byte limit: the write that crosses it stays in the shard.

- `sharding.mode: bounded` (`config/runtime.json`, `probably_obsolete/config/runtime-sharded.json`) evicts the oldest **normal** cold shards when there are more than `maxColdShards`, when normal bank bytes exceed `maxNormalBankBytes`, or when a cold shard is older than `maxColdAgeMs`; their domains, receipts and local metadata go with them.
- `sharding.mode: archive` (`probably_obsolete/config/runtime-sharded-archive.json`) never evicts; reaching `maxArchiveShards` fails the write explicitly instead of losing data. The shared reviewed knowledge base always uses archive mode, whatever the session's cache policy (`knowledgeConfig` in `memory/factory.mjs`).
- Pinned generations rotate the same way, are never evicted, and an explicit `maxPinnedBankBytes` quota fails the write rather than deleting pinned facts.

**Promotion** is the survival mechanism across generations: a verified observed fact used in a proof is re-projected into the hot shard with its original identity, provenance, earliest known time and **original** validity (never the interval clipped by the current question). Hypotheses and forged candidate objects cannot promote themselves. Promotion favors recent use; it is not an exact LRU/LFU and promises no eternal retention for something used intensively long ago. A high counter in a cold shard does not by itself protect that shard from eviction.

Retrieval visits only shards whose domains contain the queried predicate and arity (lossless routing, not approximate top-k), reconstructs candidates inside each shard and unions them by claim id. Banks of different shards are never ORed together, which would splice unrelated facts into one tuple; the reasoner joins facts across shards through rules and shared variables. `maxProbes` and `maxShards` bound one retrieval, and exhausting them reports `complete: false`, so an `output ?x one` never turns a truncated fan-out into a unique answer. End and retract events live in a separate control journal that survives the eviction of the target's shard, so a retracted fact cannot silently reappear when it is observed again, and promotion never reactivates it. Legacy cell decay is rejected on sharded memory; `migrate` imports old layers as sealed generations without replay or eviction, and geometry changes apply only to new shards.

### Repository, sessions and garbage collection

`memory/repository.mjs` stores content-addressed shard objects (`shards/<hash>.json`) and snapshot manifests (`snapshots/<hash>.json`). A base is a head pointing to a snapshot; `fork` creates a second name for the same head without copying banks. Each user has a private view; a session captures the heads when it opens and has a local layer, so an experiment does not leak into the user's memory or to others. `commit` publishes the session as a new user checkpoint; in sharded mode the checkpoint has no parent chain, because reconnecting old private checkpoints would resurrect evicted data. A commit on a stale session or an advanced user head is refused, never merged silently. `discard` restores the committed view; `close-session` releases uncommitted state. A write lock serializes local writers, manifests are published by temporary file and rename, and a failed batch changes neither memory nor disk.

Garbage collection marks base and fork heads, user heads, explicitly pinned snapshots and every open session manifest, follows snapshot parents and shard references, validates the checksum of every reachable object and only then deletes unreachable ones. A missing or corrupt reachable object stops collection. `gc` is a dry run unless applied; `gcEveryWrites` triggers it after that many persisted revisions (0 disables it). An open old session or fork deliberately retains history until it is closed. `checkpoint-base` flattens a base's chain while keeping its knowledge and historical library versions, and existing forks stay intact.

Limits: this is local isolation, not authentication, access control, encryption or quotas for a network service; it is not a distributed or power-failure-safe transaction, and a crash can leave orphan objects or a lock for an operator to check. The loader materializes banks in RAM from the manifest; there is no lazy pager. The control journal has no semantic compaction, and the library, global vocabulary, pinned memory and the shared base are outside the normal cache budget, so a bounded cache does not bound the whole process or disk.

### Base memories, forks and sessions of the chat

The chat product ([DS022](specsLoader.html?spec=DS022-sessions-and-base-memories.md)) builds on this repository without changing it. A **base memory** is a repository of one memory strategy (`memory.engine`, any of DS016 to DS020) with one base `main`, kept under `chat_data/base_memories/<id>/` beside the validated circuits it was built from and a provenance log. A **fork** reuses the content-addressing: with the same strategy the content-addressed snapshot and shard files (`<sha256>.json`, never modified in place) are hard-linked into the new folder (copy-on-write at no copy cost) and every other file is copied, a native SQLite file through `VACUUM INTO`, so parent and child share no mutable file for any strategy (`tests/memory/memory-isolation.test.mjs`); the default strategy of a base memory is `sqlite`; with another strategy the circuits are replayed into the new engine. A **session** clones its base memory the same way into `chat_data/sessions/<id>/repo/`; circuits accepted in the session are published there as new snapshots on the session's own `main`, and `Repository.rebase(session)` moves an open agent session onto the new head while keeping its local layer. Nothing a session does reaches the base memory it started from; a **commit** creates a new base memory (a fork plus the accepted circuits, validated, with provenance). Garbage collection of a cloned repository only unlinks that clone's files.

### Implementation status (verified 2026-09-28)

| Capability | Status | Evidence |
| --- | --- | --- |
| Normal/pinned banks, adaptive cooling, archive mode, proof-use reinforcement only | Implemented | `tests/memory/forgetting.test.mjs`; `tests/memory/repository.test.mjs` |
| Rotation triggers, bounded eviction, pinned and archive quotas, promotion, routing, control journal, migration | Implemented | `tests/memory/shards.test.mjs` (rotation, eviction, quotas, promotion, clipped validity, retraction survival, routing, budgets, migration) |
| Sessions, forks, stale-head refusal, atomic batches, GC roots, checksum stop, pins, base checkpoint, lock | Implemented | `tests/memory/shards.test.mjs` ("repository shards: …"); `tests/memory/repository.test.mjs` |
| All five engines through commit, restart, fork, retraction, pinned retention, bounded forgetting and GC | Observed | [DS010](specsLoader.html?spec=DS010-engine-and-solver-comparison.md) lifecycle runs (rerun 2026-09-28) |
| Lazy paging, journal compaction, segment-wise cooling, copy-on-write bank pages | Not implemented | Experiments below |

### Experiments still required

Each needs a preregistered record under [DS007](specsLoader.html?spec=DS007-experiment-preregistration.md); none needs a model or a GPU.

1. **Retention on long streams.** Compare adaptive cooling, bounded generations with promotion, and archive mode on streams with repetition, corrections and rarely used but important facts; report retained answer quality by recency × frequency × importance and the total bytes of banks plus metadata.
2. **Threshold selection.** Follow the procedure of [DS016](specsLoader.html?spec=DS016-recall-memory.md) for `safeOccupancy`, `targetOccupancy` and rotation thresholds per engine and geometry.
3. **Scale of archives.** Measure process memory, load latency and restart time for large archives, and evaluate lazy paging from disk.
4. **Garbage collection at scale.** Measure reclaimed bytes and duration with many forks and open sessions; the current evidence is a single scoped case.
5. **Crash and concurrency.** Interrupt writes, commits and GC at every step and check that integrity checks stop continuation on invalid data and that an operator can recover.
6. **Fork scaling.** Measure extra bytes per write and fork latency from 1 to 1,000 forks, with independent forgetting per branch.
