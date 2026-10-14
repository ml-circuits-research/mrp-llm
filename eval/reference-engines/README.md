# eval/reference-engines

Engines that are not product strategies and stay only as independent implementations for differential tests (demoted on 2026-10-01, owner decision in chat).

- `datalog-soplab/` is the soplab Datalog engine (soplab-v0.4.0.zip, sop-reasoning-lab 0.4.0, MIT, vendored in `vendor/`) lowered from the desugared core of the oracle. It is no longer a routing candidate and no longer a default column of the smoke harness: run it with `node eval/smoke-reasoning/run.mjs --with-reference-engines`. `tests/engines/strategy-datalog-differential.test.mjs`, `tests/engines/strategy-datalog-common.test.mjs` and `tests/engines/strategy-datalog-soplab.test.mjs` keep checking it against the oracle and against the product Datalog strategies.
