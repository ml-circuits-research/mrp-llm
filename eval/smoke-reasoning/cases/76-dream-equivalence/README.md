# 76-dream-equivalence

**Reasoning feature exercised:** The dreaming wrapper (proposal 5.6, backlog N01): after a journal of tasks of one query family, offline consolidation certifies a skill and the online run uses the frozen plan; the answer must be identical.

The rule `hit` joins `a`, `b` and `c` in the worst written order (the 40-row relation `b` is scanned for every `a` row before the 3-row `c` filters). The wrapper reorders the body atoms (a legal plan), certifies the reorder by shadow replay against the plain run, and answers with the plan.

**Expected answer:** o0, o10, o20, o30 (n0 is in `c`; its `a` row points at m0; `b` links m0 to o0, o10, o20 and o30).

**Needs:** rules, conjunction. The smoke adapter returns the answer of the deployed plan; the unit test `tests/engines/strategy-dreaming-session.test.mjs` reports the probes and the wall clock with and without it.
