# 80-long-chain-distractors-blocked

**Reasoning feature exercised:** LLM stress: a 30-step reachability chain with a cut, bypasses, blocked nodes (closed), a cycle and 60 distractor edges.

From n0 a chain of links runs to n39, but the link n23 to n24 is missing, so the main chain stops at n23. Two nodes of the chain are blocked (n7, n15, closed predicate) and are bypassed by the links n6 to n8 and n14 to n16. A side branch with a cycle starts at n10 (d0 to d9). A detour n22, z0, z1, n24 would bridge the cut, but z1 is blocked, so n24 stays unreachable; z0 itself is reached. A second branch hangs off n30 (unreachable) and 60 unrelated distractor edges add noise. The answer is a list of 32 nodes, which a model that reads the facts without applying the blocked and cut conditions gets wrong in both directions.

**Expected answer:** 32 rows: n1 to n6, n8 to n14, n16 to n23, d0 to d9 and z0.

**Needs:** facts, rules, recursion, naf, closed_world, select.
