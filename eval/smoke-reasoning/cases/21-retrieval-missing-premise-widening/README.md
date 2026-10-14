# 21-retrieval-missing-premise-widening

**Reasoning feature exercised:** Memory at scale: the first slice fails, the missing predicate is named and retrieved.

can_enter needs cleared, which needs verified, which needs id_checked: a rule chain three levels deep, in a store of 3,000 unrelated facts, 400 unrelated rules and 500 id_checked facts about other people. The first slice (radius 1) holds only the top rule; the strategy cannot conclude, but the retrieval layer sees that cleared has neither facts nor producing rules in the slice, names it as missing, and fetches its whole support at once (targeted widening). Blind widening (--widen blind) needs more steps.

**Expected answer:** supported; at least two retrieval steps; needed-wire recall 100%.

**Needs:** rules, retrieval.
