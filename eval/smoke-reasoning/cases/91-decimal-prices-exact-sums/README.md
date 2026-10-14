# 91-decimal-prices-exact-sums

**Reasoning feature exercised:** Exact decimal arithmetic in rules and aggregates: line totals (price times quantity), their sum, a count and a minimum, with no binary floating-point noise.

Four items with prices 0.1, 0.2, 19.99 and 2.5. A line total is price times quantity (0.1 x 7 is exactly 0.7, 19.99 x 3 is exactly 59.97). The basket total is the sum 71.27 (0.7 + 0.6 + 59.97 + 10), there are 4 lines, and the cheapest price is 0.1. Every engine computes decimals exactly: the integer engines as fixed point (every number scaled by 10^2), Prolog and Z3 as rationals. No engine may answer 71.27000000000001 or 0.7000000000000001.

**Expected answer:** rows as in `expected.json` (derived by the oracle and checked by hand).

**Needs:** rules, aggregate, compute_in_rules, compare_in_rules, exact_arithmetic.
