# 66-stratified-negation-chain-three-layers

**Reasoning feature exercised:** stratified negation as failure, three layers deep: s1 is the nodes that are not blocked, s2 the nodes that are not s1, s3 the nodes that are neither s2 nor special.

Each layer reads the completed layer below through `absent`, so the program has three strata above the base facts (the lowering must evaluate `s1`, then `s2`, then `s3`, in that order; evaluating them together would be wrong). Every predicate under `absent` is declared `closed true`. `bench/datalog-scale.mjs` `negationChain` builds the same shape with 10^5 nodes.

**Expected answer:** with nodes n1 to n8, blocked n1 and n2, special n5: s1 = n3 to n8, s2 = n1 and n2, s3 = n3, n4, n6, n7 and n8 (n5 is special).

**Needs:** rules, naf, closed_world, closed_derived.
