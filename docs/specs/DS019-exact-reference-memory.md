---
title: DS019-exact-reference-memory
summary: The minimal exact references - the scan engine and the optional exact tuple sidecar with its `exact` retrieval strategy - their contracts, implementation status and the experiments still required.
---

## Introduction

Two exact references sit beside SQLite ([DS018](specsLoader.html?spec=DS018-sqlite-memory.md)): the **scan** engine, the most mechanical exact memory possible, and the **exact tuple sidecar**, which lets an associative layer keep full tuple bodies for an exact control or fallback. Both answer "what was retained?" exactly within their budget and neither makes a source true. The shared bank interface is in [DS005](specsLoader.html?spec=DS005-memory.md).

## Core Content

### Scan engine

`memory/banks/scan.mjs` (`ScanBank`, `memory.engine: scan`) keeps one `Map` from tuple id to body and metadata, with no relational or lexical index, no reconstruction and no hashing of content. Every query walks the records, compares predicate, polarity and arguments and enforces repeated-variable equality; it returns exactly what was retained when the walk completes within `maxProbes` and `limit`, and search cost grows with the number of records. Re-observing a fact raises that record's own strength; `decay` lowers each record separately and deletes it at zero, so there is no interference between facts. Occupancy is records divided by `scan.maxRecords`. `stats()` reports the serialized payload size (`sizeMetric: serialized payload bytes, not V8 heap`). Configurations: `probably_obsolete/config/runtime-scan.json` and `probably_obsolete/config/runtime-scan-sharded.json`.

### Exact tuple sidecar and the `exact` strategy

With `memory.exact: true` a temporal layer or shard also stores `exactAtoms`, a map from tuple hash to the full tuple, beside the claim metadata (`probably_obsolete/config/runtime-exact.json`). The `exact` retrieval strategy (`memory/strategies.mjs`) reads only this sidecar and the claim metadata: it applies events, `at`, `during` and `asof`, and reports `visible-exact-snapshot` or `partial-exact-snapshot` coverage. The sidecar is not consulted by the associative strategies, and its cost is reported separately as `exactAtomsBytes`; it is never presented as associative compression. Enabling it after ingestion does not recreate earlier facts: re-ingest the approved sources, or accept that a layer without bodies reports incomplete coverage. The sidecar is not decayed together with the associative counters, so `hybrid` retrieval can still find a fact the associative bank has forgotten; global forgetting therefore needs its own policy on the exact layer. Ingesting with the sidecar still keeps the associative banks, for ablations on the same state, so a comparison counts every persistent structure.

### Implementation status (verified 2026-09-28)

| Capability | Status | Evidence |
| --- | --- | --- |
| Scan completion, negation, repeated variables, budgets, snapshot, fork | Implemented | `tests/memory/memory-engines.test.mjs` (engine tests for `scan`) |
| `exact` strategy across generations and after migration | Implemented | `tests/memory/shards.test.mjs` ("exact and hybrid retrieve across all retained generations", "exact coverage survives migration from exact legacy layers"); `tests/memory/linker.test.mjs` |
| Bank comparison | Observed | [DS010](specsLoader.html?spec=DS010-engine-and-solver-comparison.md): 48/48 exact sets; 10,305 and 41,560 serialized bytes at 64 and 256 atoms (rerun 2026-09-28) |

### Contracts

1. `complete: true` from scan or `exact` covers the retained records within the budget, not facts forgotten earlier and not the world.
2. The sidecar is an explicit exact store; its presence never changes what the associative strategies return.
3. Sizes are reported in their own units (serialized payload, sidecar bytes) and are never compared as if they were heap measurements or equal-byte budgets.

### Experiments still required

Each needs a preregistered record under [DS007](specsLoader.html?spec=DS007-experiment-preregistration.md).

1. **Scan scaling curve.** Latency and budget interruption from 1k to 1M records, as the floor every indexed or associative engine must beat.
2. **Sidecar cost.** Bytes of `exactAtoms` against RecallMemory counters plus metadata for the same facts, to decide when an associative layer with an exact sidecar is worth more than SQLite alone.
3. **Forgetting parity.** Once an exact-layer retention policy exists, compare answers from associative forgetting with and without the sidecar on the same stream.
