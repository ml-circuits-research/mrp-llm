# 20-retrieval-distractor-memory

**Reasoning feature exercised:** Memory at scale: symbol-driven slice from a store full of distractors.

The needed wires are 3 parent facts and 2 rules. The store also holds 5,000 parent facts about other people (the same predicate!), 4,000 facts of 40 unrelated predicates and 300 unrelated rules. Retrieval starts with rule radius 1 and one hop of constants from ann, and must widen until the constant expansion reaches its fixpoint (3 hops), without fetching the 5,000 look-alike facts. The harness reports wires retrieved against wires needed.

**Expected answer:** bob, cy, di; needed-wire recall 100%; at least two retrieval steps; far fewer wires retrieved than stored.

**Needs:** rules, recursion, retrieval.
