# 34-norm-permission-exception

**Reasoning feature exercised:** Norm with an exception: a prohibition and a permission that overrides it (lex specialis).

Production hosts may not be shut down, except in a maintenance window. The permission overrides the prohibition for the same arguments (the default machinery: the prohibition is blocked where the permission applies), so the shutdown is legal for s1. Equal-strength norms that conflict without an override would give both and be reported, never silently picked.

**Expected answer:** plan_found with shutdown (cost 1); both norms are used.

**Needs:** plan, norms_hard, overrides, used.
