# 06b-constraint-optimize

**Reasoning feature exercised:** Constraints and arithmetic: optimisation with a proven optimum.

Minimise 2x + y subject to x + y >= 5 over 0..10. The optimum is unique (x=0, y=5, objective 5). An engine that stops early must say feasible bound, not optimal.

**Expected answer:** status optimal, objective 5, witness x=0 y=5.

**Needs:** constraint, optimize.
