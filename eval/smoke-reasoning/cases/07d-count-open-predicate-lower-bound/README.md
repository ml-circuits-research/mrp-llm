# 07d-count-open-predicate-lower-bound

**Reasoning feature exercised:** A count over a predicate that is not declared closed is a lower bound, never an exact count.

Without a declaration that the staff list is exhaustive, three known employees do not make three employees. The validator warns (count_needs_closed) and the host reports the count with bound at_least. 07a is the same data with the predicate declared closed: an exact count.

**Expected answer:** count 3 with bound at_least.

**Needs:** facts, count.
