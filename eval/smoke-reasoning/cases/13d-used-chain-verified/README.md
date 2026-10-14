# 13d-used-chain-verified

**Reasoning feature exercised:** `used` by deletion, verified by replay (the case where deletion IS sufficient).

Removing f1, f2 or r_grand each loses the answer, removing f3 does not. The deletion set {f1, f2, r_grand} is replayed alone in the oracle and re-derives `supported`, so it is a sufficient support set and `used_incomplete` is false. f3 is not reported.

**Expected answer:** supported; used [f1, f2, r_grand], used_incomplete false

**Needs:** rules (`used` is filled by the host's verified deletion method for strategies that do not provide it).
