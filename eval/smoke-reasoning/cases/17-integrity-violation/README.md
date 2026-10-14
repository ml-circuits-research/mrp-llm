# 17-integrity-violation

**Reasoning feature exercised:** Integrity constraints: a violation is reported as data, not as an explosion.

A room must not be booked by two different people in the same slot. The `integrity` wire derives violation facts (id and witness) that can be queried; the rest of the knowledge stays usable.

**Expected answer:** One violation: no_double_booking with witness room1.

**Needs:** integrity, compare_in_rules.
