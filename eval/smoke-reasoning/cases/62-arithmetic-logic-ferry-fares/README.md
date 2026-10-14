# 62-arithmetic-logic-ferry-fares

**Reasoning feature exercised:** An arithmetic plus logic puzzle in one stratified program: `compute` with the integer division `whole_divided_by` (truncates toward zero), a count aggregate with set semantics, `compare` thresholds, and an exemption through `absent` over a closed predicate.

Seven passengers in three families. A child (under 12) pays their age, an adult 20, a senior (65 or more) 20 minus (age - 60) divided by 5 (so 70 pays 18 and 66 pays 19). A family of three or more takes 2 off every member's fare; an exempt passenger pays 0. Who pays more than 17? ann (20 - 2), bob (20 - 2), di (18), ed (19) and flo (20); cy pays 9 - 2 = 7 and the exempt gus 0. The same answer must come from the naive oracle, from clingo (`#count`, arithmetic in the body, `not`) and from Z3 (the aggregate evaluated by Z3 at its stratum, the rest as completion).

**Expected answer:** rows ann 18, bob 18, di 18, ed 19, flo 20.

**Needs:** rules, aggregate, compute_in_rules, compare_in_rules, naf, closed_world.
