# 75-whatif-nonmonotone-cone

**Reasoning feature exercised:** The forward cone of a what-if reaches a negation as failure (backlog N07), so the world must recompute, not continue incrementally.

Thirty shipments, each with two items; shipments s7 and s9 contain `solvent`. A shipment is flagged if it contains a dangerous item, clear if it is not flagged (`absent`, over a closed derived predicate) and shippable if it is clear and paid. The supposition s1 says that solvent is dangerous: it ADDS a fact and REMOVES the shippable rows s7 and s9 two levels downstream.

**Expected answer:** the 28 other shipments, conditional on s1, and `nonmonotone: true` (the observed-only run has rows the full run lacks).

**Needs:** naf, closed_world, closed_derived, whatif, rules.
