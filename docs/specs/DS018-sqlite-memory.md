---
title: DS018-sqlite-memory
summary: The exact SQLite memory engine and the single-file SQLite memory - indexed exact tuples, literal full-text search, persistence modes, implementation status, planned structural ranking and retention, and the experiments still required.
---

## Introduction

For a moderate number of canonical facts, memory can simply be exact storage and search. The SQLite engine (`memory.engine: sqlite`) is ChatSOP's engineering baseline for that case: an associative engine must justify its cost with a measured benefit over it. SQLite keeps formalized knowledge exact and inspectable; it enumerates, counts and certifies absence **within the retained records** when a search completes, but storage never makes a source true. It uses only Node's built-in `node:sqlite` (Node ≥ 22.13), with no npm dependency; on current Node versions that module still prints an experimental-feature warning. The shared bank interface is in [DS005](specsLoader.html?spec=DS005-memory.md).

## Core Content

### The SQLite bank

`memory/banks/sqlite.mjs` (`SQLiteBank`) keeps one `STRICT` table `atoms` with id, predicate, arity, polarity, up to four argument columns, the canonical body and JSON metadata. Arguments are encoded deterministically with their type, so the number `1` and the string `"1"` stay distinct. Four composite indexes start with predicate, arity and polarity and continue with one argument position, so `works_at ana ?org` and `works_at ?person cern` are both indexed lookups; a repeated variable becomes an equality between columns. Patterns become parameterized `WHERE` clauses; user data is never concatenated into SQL. `explain()` returns the query plan.

With `sqlite.fts` (default on) an FTS5 table (`unicode61`, diacritics removed) mirrors the bodies through triggers, and `search(text)` finds candidates by literal terms combined with AND and ranked by BM25. Terms are quoted, so user text never becomes raw FTS syntax. Lexical search only proposes candidates; a premise still needs structural matching and temporal verification, and FTS is not multilingual semantic understanding.

Writes are transactional (`transaction`, `addMany`); a failed batch rolls back and publishes no partial facts. Strength follows the same 1–15 scale as the other banks: `decay` lowers each row's strength and deletes rows that reach zero, and `maintain` in `adaptive` mode uses rows divided by `sqlite.maxRecords` as its occupancy, which is a row budget rather than a bit density. `recall` counts matched SQL rows as probes (B-tree work is not counted), respects `maxProbes` and `limit`, and reports `exact-sqlite` or `partial-sqlite` coverage. `stats()` reports database page bytes (which include B-trees and FTS), `metadataIncludedInDatabase: true` and the SQLite version.

### Two persistence modes

1. **Inside the repository.** SQLite is the default strategy of the chat product's base memories, of the `default` base memory and of sessions ([DS022](specsLoader.html?spec=DS022-sessions-and-base-memories.md)). Each layer or shard owns a private in-memory SQL view. Snapshots export the canonical rows and rebuild the indexes when loaded, so forks, sessions, promotion, snapshot hash checks and garbage collection keep working ([DS021](specsLoader.html?spec=DS021-memory-retention-and-generations.md)). This is not a native single-file repository: the repository folder holds only the content-addressed JSON snapshots and shards, never a mutable `.sqlite` file with `-wal`/`-shm`, so a fork or session clone that hard-links those files shares no mutable state with its parent (a file that is not content-addressed is copied, a database file through `VACUUM INTO`; `tests/memory/memory-isolation.test.mjs`). Loading a snapshot rebuilds the SQL indexes, so opening, clone-and-read and export cost grows with the number of rows; bank benchmarks exclude that cost and report it separately.
2. **Single-file memory.** `memory/sqlite-simple.mjs` (`SimpleSQLiteMemory`, command-line front end `tools/sqlite-simple.mjs`) keeps tuples, temporal claims (`claims`), end and retract events (`changes`) and approved SOP rules (`library`, with a hash that rejects conflicting redefinitions) in one `.sqlite` file, with no associative bank. Ingestion requires explicit reviewed approval and accepts only facts and rules. Recall finds tuples by index, then claims known at `asof`, then their changes, and only then applies retraction, interval end and `at`/`during`. A fork uses `VACUUM INTO`: a full consistent copy, not copy-on-write. It has no automatic forgetting cache, which suits an exact archive.

### Implementation status (verified 2026-09-28)

| Capability | Status | Evidence |
| --- | --- | --- |
| Indexed exact tuples, typed values, negation, repeated variables, budgets | Implemented | `tests/memory/memory-engines.test.mjs` (engine tests for `sqlite`) |
| File reopen, indexed plan, literal FTS terms, hostile syntax | Implemented | test "SQLite: file reopen, indexed plan, FTS terms and hostile syntax" |
| Transaction rollback | Implemented | test "SQLite: transaction rollback does not publish partial facts" |
| Single-file temporal claims, rule ingestion, fork, reopen | Implemented | test "single-file SQLite: temporal claims, rule ingestion, fork and reopen" |
| Bank comparison | Observed | [DS010](specsLoader.html?spec=DS010-engine-and-solver-comparison.md): 48/48 exact sets; 90,112 and 212,992 page bytes at 64 and 256 atoms (rerun 2026-09-28) |
| Wire-level schema, structural relevance ranking, utility-based eviction | Not implemented | Planned below |

### The exact substrate for completeness-sensitive retrieval

Because the SQLite bank is exact, it is the substrate on which the knowledge wires ([DS004](specsLoader.html?spec=DS004-sop.md)) can be answered under partial retrieval ([DS005](specsLoader.html?spec=DS005-memory.md) "Closedness and completeness for the knowledge wires"): a keyed lookup by predicate and argument values reports whether it is complete, a count over a predicate is exact, and a predicate declared `closed` is certified only when the bank holds the archive of its facts (`retention none`) or a pinned view. The keyed lookups are also what default conclusions need before they are accepted (the strict contrary `not p a` and each exception atom, looked up for each candidate). The bank never decides closedness itself, never infers a negation from a missing row, and an associative hint never substitutes for an exact lookup.

**Cost model at scale (2026-10-01).** A base memory published circuit by circuit is a chain of hundreds of snapshots, each a layer with its own bank. Four measures keep a question over it interactive (`tools/eval/engines/slice-timing.mjs`, `eval/reports/current/slice-path/timing.json`): (1) a bank restored from a snapshot is rebuilt lazily: its stored rows stay as they are, its predicate/arity domains are read from the rows, and its SQL database is built only when a lookup or a write first touches it, so a layer that no question reaches never builds one; (2) the chain of snapshots a session reads is cached by its two heads (`Repository.visible`) and the decoded snapshots are shared by every repository of the process by snapshot id (a session clones its base by hard links; `CHATSOP_SHARED_SNAPSHOTS`, default 512, bounds them), the file still having to exist; (3) a recall finds the claims behind a stored tuple through a per-layer index by tuple hash, built once for a frozen snapshot layer, so it costs the rows it matches and not the claims of the layers it reads; (4) retrieval asks for keyed lookups (`reasoning/slice/`), never a scan of a relation a constant can key.

### Planned extensions (not implemented)

- **Wire-level schema.** Store whole SOP wires with their scope, known and valid times, importance, pin flag, use count and last use, plus side tables for the predicates a wire uses and their role (head, premise, query, effect), the canonical entities and their roles, dependencies between wires, procedures and definitions, and multilingual aliases and ontology links.
- **Structural relevance.** Rank formalized knowledge by structural match, rule-head match, entity overlap, dependency overlap, BM25 text score, scope and temporal compatibility, with recency, use count and importance as ranking bonuses that never change stored truth. Embeddings are not the starting point for formalized data.
- **Exact retention.** Pinned rows are never removed; cache-like rows get a utility score from importance, use count, recency and scope, and low-utility rows are deleted or moved to cold archives. Archive mode never forgets automatically.

### Experiments still required

Each needs a preregistered record under [DS007](specsLoader.html?spec=DS007-experiment-preregistration.md); none needs a model or a GPU.

1. **How far exact storage goes.** Compare structural SQL retrieval, BM25 alone and hybrid retrieval on the same approved suite before crediting any associative engine.
2. **Index variants.** Measure versions without FTS, with symbol dictionaries and with minimal indexes: latency of direct and reverse lookups, database size, ingestion and snapshot-rebuild cost.
3. **Lifecycle cost.** Measure repository snapshot export and rebuild, restart latency and process memory at 10k–1M facts, and compare with the single-file mode.
4. **Exact retention.** Once utility-based eviction exists, measure retained answer quality against archive mode on long streams with corrections.

### Technical references

Node.js SQLite API (`DatabaseSync`, file and in-memory databases, prepared statements): <https://nodejs.org/api/sqlite.html>. SQLite query planning and composite indexes: <https://sqlite.org/queryplanner.html>. SQLite FTS5 tokenization and BM25: <https://sqlite.org/fts5.html>. These describe the external components; they are not results of this project.
