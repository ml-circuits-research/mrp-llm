# 07c-aggregate-then-rule

**Reasoning feature exercised:** Aggregation consumed by a rule (stratified composition).

dept_size is a count aggregate; large_dept is an ordinary rule over it. The aggregate sits in a lower stratum than its consumer.

**Expected answer:** Only dev (3 people) is a large department (at least 3).

**Needs:** aggregate, rules, compare_in_rules.
