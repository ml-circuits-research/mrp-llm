# Formalization regression set

`cases.jsonl` accumulates every formalization error reported to `state/formalization-errors/inbox.jsonl` (AGENTS.md "Formalization improvement"); `node tools/eval/formalization/regression/build.mjs` appends new cases and observations, never removes one.

A case holds references and labels only: `id` (`books/<problem id>` or `<source>/<message hash>`), `provenance` (reporter, book, problem id, first seen), `message_sha`, `gold_kind`, `area`, `grade`, `runnable` (with the reason when not), and `observations` (time, kind, strategy, tier, run, arm, structural codes). The owner's books and every text derived from them stay in the gitignored `datasets_sources/` (docs/runtime.html "Evaluating on the owner's problem books"): the runner reads the message and the gold answer from `datasets_sources/books/eval/items.jsonl` or the inbox, and annotations derived from a book text (a gold circuit, key values and formula) from `datasets_sources/formalization-regression/annotations.jsonl`. Cases from sealed suites (`eval/suites/`) are refused by provenance.

Runner, gate and wake-up: docs/runtime.html "Improving the step-by-step formalization".
