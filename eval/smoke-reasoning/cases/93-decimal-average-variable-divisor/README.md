# 93-decimal-average-variable-divisor

**Reasoning feature exercised:** A decimal average: a sum divided by a count that is a variable, exact when the quotient terminates.

Three teams. The average is the team total divided by the team size, both derived by aggregates: red (7.5 + 8) / 2 = 7.75, blue (6.5 + 9.5 + 5) / 3 = 7, green 4 / 1 = 4. The integer engines carry two extra decimal places for a division by a variable and refuse (not_expressible, the oracle answers) when a quotient needs more.

**Expected answer:** rows as in `expected.json` (derived by the oracle and checked by hand).

**Needs:** rules, aggregate, compute_in_rules, exact_arithmetic.
