# 59a-golog-strict-procedure-wrong-branch

**Reasoning feature exercised:** Conformance of a recorded trace to a STRICT procedure, the natural reading of a method as a Golog program (golog-swi).

The release manual's method `deploy` is a program: back up, then `if big_release` canary else smoke test, then `choose` a blue or green rollout, then announce. The state holds `big_release s1`, so the test is true and the run must take the canary branch. The recorded trace backs up, runs the smoke test (the else branch), rolls out green and announces. Every norm is met (the soft obligation to announce within 5 steps is triggered and met), the actions are all applicable, but the trace is not a legal run of the strict method: a deviation, which under `binding strict` is non-compliance and is listed in `deviations`.

**Expected answer:** non_compliant; hard norms ok, nothing violated, deviations [deploy], no soft violations, total cost 1 + 1 + 2 + 1 = 5; the obligation instance `announce_promptly s1` is triggered.

**Needs:** check_plan, norms_soft, temporal_norms, method, conform_deviation, used, zero_arity.
