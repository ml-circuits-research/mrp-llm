# 12c-temporal-throughout

**Reasoning feature exercised:** Time: during means "for every instant of the interval" (end exclusive); overlaps is the separate word.

Alpha holds on [2020-01-01, 2023-01-01), so it holds throughout [2021-06-01, 2023-01-01) (end exclusive); beta starts on the end date and does not. With overlaps instead of during the answer would be alpha and beta (12b).

**Expected answer:** alpha only.

**Needs:** temporal, interval, throughout.
