# 39b-norm-conflict-equal-strength

**Reasoning feature exercised:** A `both` between norms of equal strength (review round 2, SHOULD-FIX 2).

s1 is producing, so shutting it down is forbidden, and failing, so shutting it down is obligatory. Neither norm overrides the other and both are hard and strict: the engine returns `blocked` naming both ids, never a silent pick. Under `binding advisory` the result would be a reported violation of one of them (listed in `relaxed`). Adding `overrides` to one of them is the way to resolve it (case 34).

**Expected answer:** blocked, blocked_by [keep_running, must_stop]

**Needs:** plan, norms_hard, blocked_info, norm_conflict.
