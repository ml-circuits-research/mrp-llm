# 56-mutual-recursion-stratified-negation

**Reasoning feature exercised:** Mutual recursion plus stratified negation as failure.

`even` and `odd` are defined through each other over a six-node cycle (n0 to n5 and back to n0), so the two predicates live in one recursive stratum. `free_even` sits one stratum above and uses `absent blocked` (a closed base predicate, so the negation is stratified and the well-founded model equals the perfect model). Even nodes are n0, n2, n4; n2 is blocked.

**Expected answer:** n0 and n4.

**Needs:** rules, recursion, naf, closed_world.
