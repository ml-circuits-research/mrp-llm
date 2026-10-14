---
title: DS017-holo-memory
summary: HoloMemory, the bounded signed-counter associative memory - intended lifelong-memory contract, its kernel, SOP fact adapter and known-handle wire plane, implementation status, persisted identifiers and the experiments still required.
---

## Introduction

HoloMemory (formerly H7) is an associative [memory engine](wiki.html#definition-memory-engine) (`memory.engine: holo-memory`) that superposes value codes in a fixed set of signed counters and reads them back by correlation. Its motivating contract is **bounded lifelong memory**: an agent that runs for years under a fixed memory budget should learn a fact after one observation, strengthen facts that recur, let weak unrehearsed traces fade as genuinely new information arrives, and say explicitly when something can no longer be recovered. Use cases that motivated it are long-running companions, robots and edge agents, coding and research assistants, forked multi-agent memories and game characters. This specification separates that intended contract from what the code implements today.

HoloMemory follows ChatSOP's division of labour: a small model or a person provides canonical SOP, the memory stores and retrieves candidate facts with integrity information, and the reasoner decides what follows ([DS006](specsLoader.html?spec=DS006-reasoning.md)). A failure to retrieve a premise means "not remembered", never "false". The shared bank interface is in [DS005](specsLoader.html?spec=DS005-memory.md); generations and retention are in [DS021](specsLoader.html?spec=DS021-memory-retention-and-generations.md).

## Core Content

### Intended contract and its status

| Property | Intended behavior | Status (2026-09-28) |
| --- | --- | --- |
| Fixed capacity | Size set at creation; does not grow with observations | Kernel only. The fact adapter's domains and receipts grow. |
| One-shot learning | A new canonical fact is written immediately, with no training | Implemented |
| Repetition reinforces | A recognized repeat strengthens the trace without global ageing | Implemented (kernel `novelty: auto`; adapter uses receipt plus surviving signal) |
| Novelty causes ageing | Genuinely new information ages random counters one step toward zero | Implemented, off by default (`ageStepsPerNovel: 0`) |
| Graceful degradation | Damage lowers recall progressively | Tested on small cases; not measured at the claimed scale |
| Content-addressable recall | Known cues recover associated content | Only from a complete known key; partial-cue discovery is not implemented |
| Abstention | Weak or ambiguous evidence returns `uncertain` or `not_remembered` | Implemented |
| Forkable state | A branch starts from the parent state and evolves independently | Implemented by full clone; copy-on-write pages are not implemented |

### Kernel

`memory/banks/holo-kernel.mjs` holds `banks × rows × dimension` counters in one `Int8Array` (banks 2–32, rows a power of two up to 2^20, dimension 16–1024, `maxCounter` up to 127, and a 512 MiB safety cap). There is no key list. For each bank a hash of the key selects one row and regenerates a deterministic sign mask; a value is turned into a bipolar codeword from a seeded hash. A write adds `strength × codeword × mask` to the selected row of every bank, saturating at `±maxCounter`; other keys that hash to the same rows are superposed, which is how capacity is shared. A read regenerates the rows and masks, sums the unmasked signals across banks and scores each candidate value of an **explicit** candidate domain by signal and normalized correlation. The best candidate is `remembered` only when signal ≥ `minSignal` (0.35), correlation ≥ `minCorrelation` (0.15) and margin over the runner-up ≥ `minMargin` (0.10); otherwise the kernel reports `uncertain` or `not_remembered`. Scores are signal diagnostics, not probabilities. A bounded codeword cache (`maxCachedCodes`) can be rebuilt and holds no associations.

`remember` in `auto` mode reads the key first: the same value above the thresholds counts as a repeat and only reinforces; anything else is novel and first ages `ageStepsPerNovel` pseudo-randomly chosen counters one step toward zero, which weakens small pieces of many old traces rather than deleting one record. `new` and `repeat` let a caller that has verified information decide. `decay`, `eraseFraction` (damage simulation) and `fork` (full clone) complete the kernel. Under overload even a confident top candidate can be wrong, so the kernel alone never supplies accepted premises.

### SOP fact adapter

`memory/banks/holo.mjs` stores a fact with one association per argument: the key is the predicate, polarity and all *other* arguments, and the value is that argument. A query with one unknown position reads the signal once and correlates every value of that position's domain; several unknowns are enumerated smallest domain first, and repeated variables must take equal values. A candidate is returned only if every argument passes the signal and correlation thresholds **and** its SHA-256 receipt exists and has not expired; a receipt alone is not accepted as proof that the trace survives (test "fact adapter integrity gate refuses erased body even with receipt"). Rows report `verification: holo-receipt` and `scoreIsProbability: false`, and results report `coverage: retained-holo-candidates` and `exhaustiveOriginalMemory: false`. Proof-use reinforcement never triggers ageing; pinned banks, archive mode and `retention.mode: none` disable novelty ageing. `stats()` reports `boundedKernel: true` and `boundedTotal: false`, with `metadataBytes` for domains and receipts beside the counter bytes.

Many values per key interfere: a key such as "everyone at organization X" superposes hundreds of codes in the same rows. On the 2026-09-28 rerun of the [DS010](specsLoader.html?spec=DS010-engine-and-solver-comparison.md) comparison HoloMemory returned 42/48 exact result sets at 64 atoms and 28/48 at 256 atoms, against 48/48 for the exact engines, with 65,536 counter bytes. It is fast for keys with few values and is not an exact enumerator; SQLite remains the reference for complete enumeration ([DS018](specsLoader.html?spec=DS018-sqlite-memory.md)).

### Known-handle wire plane (experimental)

`tools/holo-wire.mjs` stores a whole canonical SOP wire in a separate kernel: the SHA-256 of the canonical text is the handle, and the two length bytes and every content byte are written as associations keyed by handle and position (alphabet 0–255, `maxBytes` up to 65,535, default 4,096). Recall reads the length and each byte, then requires the hash to match the handle and the text to parse; an ambiguous byte, an over-budget length, a checksum mismatch or invalid SOP returns `uncertain` with a reason. There is no wire dictionary or length table, but the caller must already know the handle; discovering handles from partial cues is not provided (`stats().handleDiscovery: false`). A reconstructed wire is never executed automatically.

### Planned two-plane architecture (not implemented)

The full design uses the same primitive in two planes inside one bounded budget: a **cue plane** in which partial structural cues (predicate, entity, time, topic, wire type) retrieve a small set of item handles, and a **content plane** that reconstructs the canonical wire from a handle, plus compact integrity data so that no reconstructed wire becomes a premise without passing the integrity gate. Its intended semantic API is `remember(wire)`, `recall(cues)` returning ranked candidate wires with confidence and integrity, `reinforce(reference, weight)` without ageing, `fork()`, `snapshot()`/`restore()` and `stats()`, with hashing, packing and ageing kept internal. Scalable forks would share fixed-size pages copy-on-write, with ageing following the same rule. None of this may be described as available until the experiments below pass.

### Configuration and identifiers

`probably_obsolete/config/runtime-holo-memory.json` (nonsharded, archive retention) and `probably_obsolete/config/runtime-holo-memory-sharded.json` (bounded generations) select `memory.engine: holo-memory` and `policy.retrievalStrategy: holo-memory`. Kernel parameters live in `memory.holoMemory`; a legacy `memory.holo` block and the legacy engine name `holo` are still accepted. `memory.hybrid.associative: holo-memory` uses HoloMemory as the hint bank of the hybrid engine ([DS020](specsLoader.html?spec=DS020-hybrid-memory.md)). Snapshots are written as `holo-fact-bank-v1`, `holo-kernel-v1` and `holo-wire-v1`; the legacy format tags listed in `HOLO_FORMATS` and `KERNEL_FORMATS` are still read. The field-key hash tag (`FIELD_TAG` in `memory/banks/holo.mjs`) keeps its historical spelling on purpose, because changing it would re-address every stored trace. The files keep their `holo*.mjs` names, and `tools/bench-holo-memory.mjs` produces new kernel and known-handle observations.

### Experiments still required

None of the following has been run. Each needs a preregistered record under [DS007](specsLoader.html?spec=DS007-experiment-preregistration.md), runs on CPU and reports canonicalization errors separately from storage errors.

1. **Five-seed kernel table.** The archived design document reports exact-recovery accuracy for 3,000 synthetic key→symbol associations at 16, 32, 64 and 128 KiB, before and after erasing 10%, 30% and 50% of counters, as means over five seeds. Those figures have never been reproduced and are not cited as evidence. Rerun the grid with five fixed seeds, a matched alphabet, thresholds and codeword scheme, reporting forced rank-1 accuracy, accepted-answer precision, false acceptance on absent keys and total bytes including the code cache. `tools/bench-holo-memory.mjs` is the starting point; it currently defaults to three seeds and is not a reproduction.
2. **Total bytes and metadata.** Measure counters, domains, receipts, claim metadata and indexes of the fact adapter from 10k to 1M facts, and state whether any bounded-total claim holds under explicit metadata policies.
3. **Partial-cue discovery.** Implement the cue plane and measure recall@k and the false-candidate rate for entity, predicate and time cues at 4–256 MiB, without an explicit growing record index.
4. **Full-wire storage at scale.** Store 10k–1M canonical wires by handle; measure exact recovery, bytes per wire and latency under damage.
5. **Integrity gate.** Measure the false-accepted-premise rate of the adapter and the wire plane; the target is orders of magnitude below the raw retrieval error.
6. **Continual forgetting.** On streams of 1M–100M observations, compare novelty-gated ageing with ageing on every write by retention across recency × frequency × importance, and measure the precision of self-detected repetition.
7. **Many values per key.** Evaluate sub-keys, buckets and group routing against SQLite enumeration on keys with hundreds of values, and sweep the three thresholds.
8. **Equal-byte comparison.** At the same total bytes, compare HoloMemory with RecallMemory, a bounded vector store, a reservoir or replay store, an exact cache and SQLite.
9. **Fork scaling.** Branch 1–1,000 forks with copy-on-write pages; measure extra bytes per write, fork latency and isolation of independent forgetting.
10. **Reasoning loop.** On rights-cleared ProofWriter-style tasks translated to SOP ([DS011](specsLoader.html?spec=DS011-source-rights.md)), measure premise recall and final proof accuracy when retrieval and reasoning alternate.

### Related work

HoloMemory combines ideas with substantial prior art; the research question is whether the combination gives a useful memory contract for symbolic agents. Sparse distributed memory and vector-symbolic architectures (Kanerva, *Sparse Distributed Memory*, MIT Press, 1988; Plate, "Holographic Reduced Representations", IEEE Transactions on Neural Networks 6(3):623–641, 1995, DOI 10.1109/72.377968) provide distributed storage, binding and graceful degradation. Stable Bloom filters (Deng and Rafiei, ACM SIGMOD 2006, 25–36, DOI 10.1145/1142473.1142477) evict stale information in fixed space but answer approximate membership, not associations. Retrieval-augmented generation (Lewis et al., NeurIPS 2020) keeps explicit items that grow without a retention policy. Learned neural memories (Wang et al., MEMORYLLM, ICML 2024; Behrouz, Zhong and Mirrokni, Titans, 2025) are parametric, whereas HoloMemory writes non-parametrically and keeps language interpretation, storage and reasoning separate.
