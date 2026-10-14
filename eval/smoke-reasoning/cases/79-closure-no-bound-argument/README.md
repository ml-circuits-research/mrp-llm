# 79-closure-no-bound-argument

**Reasoning feature exercised:** The router rule of the native closure template needs a bound argument (a BFS from one node); with both arguments free the template is `not_expressible` and the rules answer (a sound refusal, not a weaker answer).

**Expected answer:** (a,b), (a,c), (b,c).

**Needs:** rules, recursion.
