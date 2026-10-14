# 81a-count-distinct-closed-joins

**Reasoning feature exercised:** LLM stress: an exact count of distinct bindings over closed predicates with duplicates, a comparison and absence.

Forty employees work on eight projects (some on two or three: the same employee appears in several rows of the join and counts once). The count is of distinct employees who work on a project with a budget above 100 and are not on leave. All predicates of the join are declared closed, so the count is exact: no bound field.

**Expected answer:** an exact count (see expected.json), no bound.

**Needs:** facts, count, closed_world, naf, compare_in_rules.
