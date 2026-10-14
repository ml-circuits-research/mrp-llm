# 41b-rejected-norm-never-binds

**Reasoning feature exercised:** Only approved wires bind (8.3): a norm the host rejected, like one that is only proposed, enters a query only when the query supposes it with `if`.

The same prohibition as in 41a, but `approval rejected`: it does not bind, the shutdown is legal and there is no flag.

**Expected answer:** plan_found with shutdown (cost 1).

**Needs:** plan, norms_hard, versions, used.
