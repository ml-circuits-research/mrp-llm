# 82-defaults-priority-ladder-exceptions

**Reasoning feature exercised:** LLM stress: defaults on a priority ladder with an exception that disables a default, a strict contrary and equal-strength sources.

Birds fly (priority 1), penguins and ostriches do not (2), a jetpack makes a bird fly (3), an injured bird does not fly (4) unless it has been rescued, and a rescued bird flies (4). Nine animals carry different combinations. A default blocks a lower one only when it FIRES: an injured bird that is rescued has its injured default switched off by the exception, so it blocks nothing and the rescued default decides. Animal g has a strict negative fact, which sits below every default.

**Expected answer:** a, c, f, h and i fly; b, d, e are refuted by a higher default and g by the strict fact (none of them is a row).

**Needs:** default, overrides, strict_contrary.
