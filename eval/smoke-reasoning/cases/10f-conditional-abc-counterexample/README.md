# 10f-conditional-abc-counterexample

**Reasoning feature exercised:** Conditional answers are verified, not assumed exact (review round 2, MUST-FIX 2).

Three suppositions a, b, c; the row `ok z` needs c and (a or b). Removing a leaves the row (b supplies it), removing b leaves it (a supplies it), removing c drops it: leave-one-out gives [s_c]. Saying "if c" is wrong, because with c alone the row does not hold. The host therefore runs the verification (observed facts plus the leave-one-out set only): the row is gone, so the list is not exact. The row is conditional on all three assumptions and `conditional_unknown` is set (a sound, non-minimal list; the minimal set is not unique: {a, c} and {b, c}).

**Expected answer:** row z, conditional [s_a, s_b, s_c], conditional_unknown true (per row and for the packet)

**Needs:** whatif, rules.
