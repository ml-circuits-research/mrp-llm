# 55-left-recursion-cyclic-graph

**Reasoning feature exercised:** Left recursion on a cyclic graph (the prolog-tabling case).

`reach` is the transitive closure of `edge` written with the recursive call FIRST (`reach ?x ?m` before `edge ?m ?y`), the form that makes plain Prolog loop. The graph has the cycle a-b-c-a, a second cycle d-e-d behind it, and a node `f` that points into the graph but is not reachable from `a`. A tabled engine (SLG resolution), a bottom-up fixpoint and a visited-set search all terminate and agree.

**Expected answer:** From a one reaches a (through the cycle), b, c, d and e, and not f.

**Needs:** rules, recursion.
