# 23-retrieval-derived-closed-missing-rule

**Reasoning feature exercised:** Memory at scale: absent over a recursive derived predicate is valid only if every rule of it is in the slice.

reach is a closed, recursive, derived predicate with two rules. The rule library delivers rules by head with a cap, so the first slice holds only the base rule: reach is then just edge, c looks unreached, and the strategy reports a, c, d. Negation as failure over a derived predicate is valid only if the slice holds every rule with that head (rulesFor reports complete false) and, recursively, for the predicates in their bodies. The validator, given the retrieval manifest, flags the absent in the first slice; the host widens the rule set and the second slice answers a and d.

**Expected answer:** rows a and d, after at least two retrieval steps; with the guard disabled the first answer (a, c, d) is accepted and wrong.

**Needs:** rules, recursion, naf, closed_world, closed_derived, retrieval.
