# 04-recursion-transitive-closure

**Reasoning feature exercised:** Recursion and transitive closure on a cyclic graph.

reaches is the transitive closure of edge. The graph has the cycle a-b-c-a, so naive top-down search loops; a correct engine terminates (tabling, fixpoint or visited set).

**Expected answer:** From a one reaches a, b, c and d (a again through the cycle).

**Needs:** rules, recursion.
