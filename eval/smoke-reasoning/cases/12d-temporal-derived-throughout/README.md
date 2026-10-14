# 12d-temporal-derived-throughout

**Reasoning feature exercised:** Time for derived atoms: snapshot semantics (a derived atom holds at t iff its body holds at t).

ann works at alpha until 2023, bob from 2022. The derived atom colleague ann bob holds exactly on the intersection [2022-01-01, 2023-01-01), computed by partitioning the interval at the endpoints of the body facts. The query interval lies inside it.

**Expected answer:** supported.

**Needs:** temporal, interval, throughout, snapshot_derived, rules, compare_in_rules.
