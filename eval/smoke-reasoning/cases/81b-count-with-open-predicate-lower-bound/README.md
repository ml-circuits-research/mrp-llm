# 81b-count-with-open-predicate-lower-bound

**Reasoning feature exercised:** LLM stress: the same count with one open predicate in the join is only a lower bound.

The data of 81a, with the extra condition that the employee is certified. The predicate certified is not declared closed (twelve employees are known to be certified, the list is not stated to be complete), so the host reports the count with bound at_least. Open versus closed is the whole difference from 81a.

**Expected answer:** the number of known matches with bound at_least.

**Needs:** facts, count, closed_world, naf, compare_in_rules.
