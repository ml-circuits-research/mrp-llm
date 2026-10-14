# 07b-aggregate-group-sum

**Reasoning feature exercised:** Aggregation: a derived relation defined by group-by and sum.

dept_payroll is an `aggregate` wire (group by department, sum of salary). Rows of `over` are distinct bindings of all its variables, so two people with equal salaries both count.

**Expected answer:** dev 310, ops 175.

**Needs:** aggregate.
