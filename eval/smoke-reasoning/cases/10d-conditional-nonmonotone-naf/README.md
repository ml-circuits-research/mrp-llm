# 10d-conditional-nonmonotone-naf

**Reasoning feature exercised:** Conditional answers under negation as failure are non-monotone: a supposition can remove a row, and the packet says so.

Supposing that b is blocked removes b from the open nodes. Without the supposition the rows are a, b, c; with it a and c. A conditional answer under negation as failure is therefore not a subset-or-superset of the unconditional one, which the host flags as nonmonotone so the renderer does not say "and also".

**Expected answer:** rows a and c, conditional [s1], nonmonotone true.

**Needs:** naf, closed_world, whatif.
