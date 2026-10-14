# 71-vrc-product-world-small

**Reasoning feature exercised:** Numeric planning with exact rationals (the product world of VRC, extension E2).

Three pairs (a, b) = (1,2), (2,3), (3,1). The laws scale a by 2 and b by 1/2, swap them, or negate both, so every product a*b is invariant (2, 6, 3 per bucket; the fourth bucket is empty). `q` accumulates the products of one bucket per action; the goal is `q` at least 20. The fractions 1/2 are exact rationals, never floats.

**Expected answer:** plan_found, four steps (6 per step at best: three steps give 18, four give 24).

**Needs:** plan, numeric_action, zero_arity.
