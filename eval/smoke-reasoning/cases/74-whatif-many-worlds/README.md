# 74-whatif-many-worlds

**Reasoning feature exercised:** Many hypothetical worlds over one base (proposal backlog N06; the sop-r copy-on-write worlds).

A base of 71 machines in zones; machine m0 is overloaded (observed), so zone z0 is escalated. Ten supposed facts s1 to s10 each say that one more machine (m1 to m10, each alone in its zone) is overloaded. The question "which zones are escalated, if all ten hold?" is answered by the host as one world, and its per-row `conditional` list needs a world for the full set, one for each leave-one-out and one verification world per row: more than twenty sibling worlds over the same base.

**Expected answer:** z0 (unconditional) and z1 to z10, each conditional on exactly its own supposition s_i.

**Needs:** whatif, rules, conjunction. The strategy `worlds-sopr` answers the conditional lowering as forks of one engine.
