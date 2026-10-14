# 05b-naf-closed-world

**Reasoning feature exercised:** Negation as failure over a declared closed predicate.

`absent blocked ?x` is true when no blocked fact is derivable. It is only allowed because blocked is declared closed (the source lists every blocked node). Stratified: blocked does not depend on open_node.

**Expected answer:** a and c are open; b is blocked.

**Needs:** rules, naf, closed_world.
