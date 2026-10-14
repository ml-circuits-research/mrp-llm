# 12g-temporal-count-throughout

**Reasoning feature exercised:** Interval combination: `count` under `during` counts the rows present throughout (review round 2, SHOULD-FIX 7).

The interval [2021-06-01, 2023-01-01) is partitioned at the endpoints of the facts in the slice (2022-01-01, 2022-06-01 and the interval ends) into four parts. alpha holds in every part, gamma only in one, beta in none (it starts on the end date). The count is the number of rows present in every part: 1. Under `overlaps` a count is not specified (the rows would be counted with their validity, a different question); `every` under `during` holds when it holds in every part.

**Expected answer:** count 1

**Needs:** temporal, interval, throughout, count.
