# 22-retrieval-naf-needs-complete-keys

**Reasoning feature exercised:** Memory at scale: negation as failure is valid only over fully retrieved closed predicates.

open_node holds for nodes with no blocked fact (blocked is closed). Memory holds 6 nodes, of which n2 and n5 are blocked, and 2,000 blocked facts about unrelated entities, stored first so a capped scan of blocked returns only distractors. The first slice (cap 8) is truncated on blocked: a strategy would read the missing blocked n2 and n5 as absent and answer all six nodes open, which is WRONG. The proposal rule withholds any answer that depends on absence unless the predicate is fully retrieved for the relevant keys; the retrieval layer then fetches blocked per retrieved node (keyed lookup) and the answer becomes correct. With --unsafe-naf the guard is off and the harness counts the wrong answer.

**Expected answer:** n1, n3, n4, n6 (not n2, n5); first slice withheld; keyed retrieval of blocked; wrong answer if the guard is disabled.

**Needs:** rules, naf, closed_world, retrieval.
