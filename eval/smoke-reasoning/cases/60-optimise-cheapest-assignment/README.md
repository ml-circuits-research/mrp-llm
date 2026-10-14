# 60-optimise-cheapest-assignment

**Reasoning feature exercised:** Optimisation: the cheapest assignment of a finite problem, proved optimal (`#minimize` in ASP, `minimize` in Z3, enumeration in the oracle).

Three kinds of pack (vitamin value 3, 4 and 6, price 2, 3 and 6) must give at least 18 units with at most 5 packs. The cheapest cost is 13, reached only by (a, b, c) = (2, 3, 0): two of the first, three of the second, none of the third. A strategy that stops early must say feasible bound, not optimal.

Ties are not in this case on purpose: with a price of 5 for the third pack two assignments reach 13, (2, 3, 0) and (4, 0, 1), and the current `z3-lia` product route reports no witness for an ambiguous optimum. The oracle returns the first optimum in its enumeration order (variables in declaration order, ascending), so the solver strategies break ties lexicographically with lower-priority objective terms (clingo `#minimize` levels, Z3 `opt.priority lex`); that variant is checked in `tests/engines/strategy-asp-clingo.test.mjs` and `tests/engines/strategy-z3-smt-bounded.test.mjs`.

**Expected answer:** status optimal, objective 13, witness a=2 b=3 c=0.

**Needs:** constraint, optimize.
