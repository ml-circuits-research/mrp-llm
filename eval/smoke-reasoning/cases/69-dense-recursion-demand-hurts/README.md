# 69-dense-recursion-demand-hurts

**Reasoning feature exercised:** nonlinear recursion (`reach(x,z) :- reach(x,y), reach(y,z)`) on a dense digraph, counted over all pairs (no argument is bound).

This is the shape on which E10's demand rewriting does not help and the inventory records a regression (Z09, Z15): with no bound argument the magic seed demands everything, so the rewritten program computes the same closure plus the demand relations and the adorned copies; the `verified` mode lost to greedy on dense cycles (14,612 against 6,964 probes). `bench/datalog-scale.mjs` `denseNonlinear` builds the same circuit with 300 nodes; the speed table reports `datalog-e10` with demand on and off. `reach` is declared closed, so the count is exact.

**Expected answer:** the number of ordered pairs (x, y) with a path from x to y, nodes of a cycle included; the graph of the smoke instance has 6 nodes and the count is derived by a breadth-first search in the generator.

**Needs:** rules, recursion, naf, closed_world, closed_derived, count.
