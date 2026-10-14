# 06d-rule-arithmetic

**Reasoning feature exercised:** Arithmetic inside rules (compute and compare over bound values).

line_total is quantity times price (compute); big_order filters totals above 100 (compare). Arithmetic is finite and non-recursive, so evaluation terminates.

**Expected answer:** o1 (3 x 40 = 120) and o3 (2 x 60 = 120) are big orders; o2 (5 x 10 = 50) is not.

**Needs:** rules, compute_in_rules, compare_in_rules.
