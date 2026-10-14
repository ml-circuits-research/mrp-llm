# 04b-recursion-cycle-completion-caveat

**Reasoning feature exercised:** Recursion plus negation as failure on a cyclic graph: completion alone is unsound (Z3 must decline recursion).

a and b form a cycle, c is isolated. The least model has reach a a, reach a b, reach b a, reach b b and nothing about c. Clark completion over the finite domain also admits a model in which reach a c and reach b c hold (they support each other around the cycle), so a Z3 lowering that only completes the rules would fail to conclude that c is unreached. The proposal makes z3-smt-bounded decline recursion (not_expressible) until loop formulas or a rank encoding exist; 09a passed in round 1 only because it has no recursion.

**Expected answer:** rows: c only.

**Needs:** rules, recursion, naf, closed_world, closed_derived.
