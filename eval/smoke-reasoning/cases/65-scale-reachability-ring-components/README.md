# 65-scale-reachability-ring-components

**Reasoning feature exercised:** transitive closure at scale, a recursive query answered from a graph of many small components.

The smoke instance is 3 rings of 5 nodes (15 `edge` facts); `bench/datalog-scale.mjs` `ringComponents` builds the same circuit with 10^4 rings of 10 nodes (10^5 facts, 10^6 derived `reach` pairs) and 10^5 rings of 10 nodes (10^6 facts). The query asks what `n0_0` reaches: its own ring, five nodes, itself included (the cycle).

**Expected answer:** n0_0 to n0_4. The answer is known by construction at every size; the oracle runs the same circuit at 10^3 facts in the speed table, the Datalog strategies at 10^5 and 10^6.

**Needs:** rules, recursion.
