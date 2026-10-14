---
name: manage-shards
description: Maintain local ChatSOP memory generations, retention, copy-on-write snapshots, migration and safe garbage collection.
---

This skill covers **memory** shards (repository generations and banks, [DS021](../../docs/specs/DS021-memory-retention-and-generations.md)), not the 50 MB JSONL file shards written by `lib/jsonl-shards.mjs` and checked by `node tools/shard-large-files.mjs --check`.

Read `probably_obsolete/legacy/requirements/18-sharduri.md`, `probably_obsolete/legacy/requirements/03-memorie.md`, `probably_obsolete/legacy/requirements/05-timp.md` and `probably_obsolete/legacy/requirements/17-algoritmi.md` before modifying storage.

Use the Repository API for writes. Do not edit content-addressed blobs in place. Keep generation geometry inside each shard; a new configuration affects new banks only. Normal cache limits do not authorize deleting pinned memory, control events, base knowledge or snapshots still referenced by sessions/forks.

Promote only verified observed facts used in a proof. Copy the original claim metadata, not the query-clipped interval. Preserve all correction events needed to avoid resurrecting a claim. Keep historical library versions across checkpoints for `asof` queries.

Run migration explicitly and preserve banks without pretending to reverse their hashes. Use archive mode for conservative migration. Explain that the next bounded maintenance may intentionally evict excess generations. Back up a real repository before administrative migration.

Run `node --test tests/memory/shards.test.mjs`, `node examples/shards-demo.mjs`, `node tools/bench-shards.mjs` and then `node tools/verify.mjs`. Test both `bounded` and `archive`, as well as corruption rejection, stale sessions, frozen forks, time filters and an actual SOP proof crossing generations.

GC is dry-run by default at the CLI. Use `--apply` only for the authorized repository. Closing a session discards its uncommitted manifest. Do not close sessions belonging to someone else merely to satisfy a disk budget.

Report counters, dictionaries, receipts, provenance, journals and persisted objects separately. Do not claim a constant total memory footprint from the normal-bank quota, nor distributed/Internet-scale performance from local tests.
