# 68-magic-set-selective-query

**Reasoning feature exercised:** a query bound on its first argument over a recursive predicate, in a graph that is mostly irrelevant to it.

The smoke instance is a chain c0 to c5 and two rings of 4 nodes. `bench/datalog-scale.mjs` `selectiveChain` builds the same shape with 2,000 rings of 50 nodes (10^5 facts, 5 * 10^6 pairs in the all-pairs closure of the rings), where a bottom-up engine that computes the whole closure does 5 * 10^6 derivations for an answer of five rows, and a demand-driven one (magic sets, E10 `demand`, Soufflé `-m`) touches only the chain.

**Expected answer:** c1 to c5.

**Needs:** rules, recursion.
