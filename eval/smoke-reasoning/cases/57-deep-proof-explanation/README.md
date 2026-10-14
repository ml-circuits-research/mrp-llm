# 57-deep-proof-explanation

**Reasoning feature exercised:** Explanation of a deep recursive derivation.

`ancestor p0 p8` follows a chain of eight `parent` facts, but one extra fact (`parent p0 p3`) is a shortcut. The explanation is the derivation of least height: the shortcut, then p3 to p8 (height 6), not the eight-step chain. A tabled engine computes the height with a mode-directed table; a bottom-up engine records the round at which an atom first appears. `used` is that proof's leaves and rules (one sufficient support set), and replaying it alone must re-derive the answer.

**Expected answer:** supported; explanation depth 6, using the six parent facts of the shortcut route.

**Needs:** rules, recursion, explain, used.
