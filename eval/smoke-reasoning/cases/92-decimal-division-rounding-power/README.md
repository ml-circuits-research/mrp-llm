# 92-decimal-division-rounding-power

**Reasoning feature exercised:** Exact decimal words of compute: divided_by a constant, rounded_to, rounded_up_to, rounded_down_to, power, whole_divided_by and modulo over decimals and negative numbers.

Four amounts (19.99, -2.75, 7, 0.1). `divided_by 4` is exact (19.99 -> 4.9975, 0.1 -> 0.025); `rounded_to 0.5` rounds half away from zero (-2.75 -> -3); `rounded_up_to 1` takes the next multiple (-2.75 -> -2); `rounded_down_to 0.25` the previous one (19.99 -> 19.75); `power 2` of 0.1 is 0.01; `whole_divided_by 2` of 7 is 3 and `modulo 4` of 7 is 3.

**Expected answer:** rows as in `expected.json` (derived by the oracle and checked by hand).

**Needs:** rules, compute_in_rules, exact_arithmetic.
