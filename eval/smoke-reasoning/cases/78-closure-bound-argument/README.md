# 78-closure-bound-argument

**Reasoning feature exercised:** The native closure template (router rule, proposal 10.2, backlog N18): `reaches` is the transitive closure of `edge`, written left-linear this time, with a cycle (n1 n2 n3), a diamond into n5 and a disconnected component (n8 n9).

**Expected answer:** from n0 one reaches n1, n2, n3, n4, n5, n6, n7 (not n0, which no edge returns to, and not n8 or n9).

**Needs:** rules, recursion. `closure-template` answers it with one BFS; the oracle and the Datalog engines with the rules.
