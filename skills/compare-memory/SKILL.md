# Compare memory strategies without changing the semantic task

Use the same approved SOP corpus, ontology, query suite, temporal cutoffs and reasoner for every engine. Ingest into independent repository roots. Select `memory.engine` and the matching provider; do not relabel a RecallMemory bank as HoloMemory or SQL. Use `auto` only for intentional mixed snapshots, never to claim isolated benchmark results.

Run `examples/memory-demo.mjs` and `tests/memory/memory-engines.test.mjs` before benchmarks. Run `tools/bench-memory.mjs` for the field-completion and reverse tasks, then `tools/summarize-memory.mjs`. Report recall, precision, complete answer sets, budget truncation and latency. Count arrays, dictionaries, receipts, claim metadata, indices and snapshot cost separately. Never give the decoder evaluator-only ground truth.

For HoloMemory ([DS017](../../docs/specs/DS017-holo-memory.md)) distinguish the standalone fixed-memory kernel, the SOP field adapter with explicit metadata, and the known-handle wire plane. Do not claim fully bounded partial-cue wire discovery. Never treat correlation or an empty approximate result as a proof of truth or falsity. With new rules, require the same review as for all SOP ingestion.

Keep Node `.mjs` implementation and parameterized offline scripts. Record seeds, runtime version, raw query results and input checksums. Add regressions for every recovered bug. Check a fresh extraction after modifying the package.
