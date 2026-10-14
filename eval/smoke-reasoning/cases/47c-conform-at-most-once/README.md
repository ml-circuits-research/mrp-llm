# 47c-conform-at-most-once

**Reasoning feature exercised:** The qualifier `at_most_once` (8.2 table) over a recorded trace: the first restart of s1 is allowed, the second is the violation. (The same instance twice; two different services would be fine.)

**Expected answer:** non_compliant, violated [one_restart], total cost 4.

**Needs:** check_plan, norms_hard, temporal_norms, zero_arity.
