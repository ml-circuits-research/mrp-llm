# 12f-temporal-time-variables

**Reasoning feature exercised:** Time variables: start_of binds the start of a stored validity, order compares them in a rule body.

A person moved from alpha to beta when her alpha employment started before her beta employment. start_of reads the stored validity of a base fact (it is not allowed on derived atoms: the validator reports time_leaf_on_derived), and order compares the two time variables. ann moved from alpha to beta; cy did the opposite.

**Expected answer:** ann.

**Needs:** temporal, rules, time_vars.
