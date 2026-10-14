# 45a-conform-asof-query

**Reasoning feature exercised:** `asof` on a conformance query (8.4 rule 1): the steps of the trace carry no `at`, so each is judged against the wires in force as of 2026-01-01.

As of that date the prohibition (approved 2026-01-15) and method version 2 (2026-09-30) did not exist; the method in force was version 1 (hard reset, then verify), which the trace follows. Judged today the same trace is non_compliant twice over: it hard-resets in business hours and it skips the notification step of version 2.

**Expected answer:** compliant, total cost 2, used reset_router_v1.

**Needs:** check_plan, norms_hard, method, conform_asof, versions, zero_arity, used.
