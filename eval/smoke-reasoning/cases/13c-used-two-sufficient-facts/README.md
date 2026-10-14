# 13c-used-two-sufficient-facts

**Reasoning feature exercised:** `used` is one sufficient support set, not the set whose deletion changes the answer (review round 2, MUST-FIX 3).

`ok z` is derivable through fa and r1 or through fb and r2, each alone sufficient. Deleting any single claim leaves the answer unchanged, so the deletion method returns an empty set; the host's replay of that empty set fails, so the packet carries `used_incomplete: true` (distinct from `conditional_unknown`) and promotes nothing. A strategy that provides `used` returns the leaves of one proof, e.g. [fa, r1]. The comparator accepts either, and replays the returned `used` alone in the oracle: it must re-derive `supported`. It never compares leaf sets.

**Expected answer:** supported; used contains fa and r1, or fb and r2, or the packet says used_incomplete

**Needs:** rules (`used` is filled by the host's verified deletion method for strategies that do not provide it).
