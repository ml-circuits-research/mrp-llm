# 09a-default-exception

**Reasoning feature exercised:** Defaults and exceptions: birds normally fly, penguins are the exception.

The default applies to every bird unless an exception holds. A penguin is a bird by a rule, yet the default must not fire for it. Desugars to stratified negation as failure.

**Expected answer:** Only tweety flies; pingu is silently not covered by the default (and not refuted either).

**Needs:** rules, default.
