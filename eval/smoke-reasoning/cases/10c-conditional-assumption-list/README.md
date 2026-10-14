# 10c-conditional-assumption-list

**Reasoning feature exercised:** Conditional answers name the assumptions they rest on (the two-run lowering), not a bare flag.

Two suppositions are made but only s1 matters for the question. The host runs the strategy with and without each assumption: ann appears only with s1, nothing changes without s2. The answer is conditional on [s1] alone, and the renderer can say "if Ann works there".

**Expected answer:** rows ann and bob, conditional [s1].

**Needs:** whatif.
