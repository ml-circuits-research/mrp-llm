# 37c-conform-trace-asof-old

**Reasoning feature exercised:** Conformance with time: a trace step carries `at`, and is judged against the versions in force at that date (review round 2, SHOULD-FIX 5).

The hard reset was performed on 2026-01-10. The prohibition no_hard_reset_in_hours was approved on 2026-01-15 and method version 2 on 2026-09-30, so on 2026-01-10 neither was in force: the method in force was version 1 (hard reset, then verify), which the trace follows. The same trace judged today (case 37a) is non_compliant. `conform` takes `asof` (default now) for steps without `at`. Conformance is purely relational, so it lowers to core rules (step-indexed facts, norms as rules deriving `violated`) and runs on every Datalog strategy.

**Expected answer:** compliant, total cost 2; used reset_router@1 version 1 and the two actions

**Needs:** check_plan, norms_hard, method, conform_asof, versions, zero_arity, used.
