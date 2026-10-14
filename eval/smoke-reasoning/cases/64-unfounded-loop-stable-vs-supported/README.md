# 64-unfounded-loop-stable-vs-supported

**Reasoning feature exercised:** Stable models against supported models. `warm` and `hot` support each other through a positive loop (`hot <- warm`, `warm <- hot`) and `warm` has one external reason (a heater). In room `n2` there is no heater, so the only STABLE (and least) model leaves `warm n2` false and `cold n2` is derivable. The Clark completion of the same rules also has a model with `warm n2` and `hot n2` both true, each supported by the other, so a completion-based engine would wrongly drop `cold n2`.

Declared outcomes: the oracle and clingo (stable models) answer `cold n2`; `z3-smt-bounded` declares recursion unsupported and answers `not_expressible` (never a weakened answer). `probes/z3-64-unfounded-loop.smt2` runs the completion under the private Z3 and shows the extra model (`sat` for `warm n2`), the second probe of the recursion caveat after `04b`.

**Expected answer:** rows x = n2.

**Needs:** rules, recursion, naf, closed_world, closed_derived.
