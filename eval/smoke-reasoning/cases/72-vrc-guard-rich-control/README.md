# 72-vrc-guard-rich-control

**Reasoning feature exercised:** The negative control of VRC's state compression (extension E2): the guard `?a at_least 1` and the bilinear observable `q + a*b` with a scaling and a swap law admit no encoding smaller than the state itself.

State (q, a, b) = (0, 2, 3). `scale` doubles a and halves b, `swap` exchanges them; both add a*b to q. Goal: q at least 12.

**Expected answer:** plan_found with two steps (scale, scale: 6 + 6). The certified encoding keeps all three coordinates, so the compressed search visits exactly as many states as the full one (the bench reports the cold-start loss once learning is counted).

**Needs:** plan, numeric_action, zero_arity.
