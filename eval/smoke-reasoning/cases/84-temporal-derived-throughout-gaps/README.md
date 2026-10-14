# 84-temporal-derived-throughout-gaps

**Reasoning feature exercised:** LLM stress: a derived fact throughout a period: adjacent shifts, a one-day gap, expiry inside the period, an exclusive end.

may_operate x crane holds at an instant when the certificate and a shift hold at that same instant. Throughout 2026-03-01 to 2026-06-01 (end exclusive): ann has two adjacent shifts (covered), bob has a one-day gap on 2026-04-01 (not covered), cy's certificate expires on 2026-05-15, di's shift ends exactly at the end of the period, ed's certificate starts on 2026-03-15, flo's two shifts and certificate fit exactly, gus has overlapping shifts, hal has a gap on 2026-03-31.

**Expected answer:** ann, di, flo, gus.

**Needs:** temporal, interval, throughout, snapshot_derived.
