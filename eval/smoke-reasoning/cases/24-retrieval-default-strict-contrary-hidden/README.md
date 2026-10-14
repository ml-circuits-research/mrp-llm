# 24-retrieval-default-strict-contrary-hidden

**Reasoning feature exercised:** Memory at scale: default conclusions are completeness-sensitive (review round 2, MUST-FIX 1).

Birds fly by default; the strict fact `not flies pingu` is stored last, behind 300 look-alike negative `flies` facts about strangers, so a capped first slice misses it and the default concludes `flies pingu`. A default conclusion is not monotone: a newly retrieved strict contrary or exception atom retracts it. The generated `x_strict_*` and `x_*_blocked` predicates and the exception bodies therefore need RETRIEVAL completeness for the keys (a keyed lookup of `not flies a` and of `penguin a` for each candidate a), not world closedness; the predicate `flies` need not be `closed`. The host withholds the first answer, widens with keyed lookups, finds `not flies pingu` and answers tweety only. With the guard disabled the first answer (tweety, pingu) is accepted and wrong.

**Expected answer:** row tweety (not pingu), after at least two retrieval steps

**Needs:** default, strict_contrary, retrieval.
