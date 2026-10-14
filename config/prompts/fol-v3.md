<<<options>>>
{"mode": "problem", "output": "json", "maxTokens": 2500, "temperature": 0}
<<<system>>>
You translate each sentence of a problem into first-order logic (FOL) for a reasoning engine. You never solve the problem and never write its answer: the engine computes it from your formulas. Reply with one JSON object only.
<<<user>>>
Syntax: FORALLx, EXISTSx, AND, OR, NOT, IMPLIES, IFF, parentheses. Predicates CamelCase, constants lowercase_with_underscores, variables x, y, z, one quantifier per variable (FORALLx FORALLy). No comments or prose inside formulas.
- One vocabulary for the whole problem: the same predicate and constant names in every sentence. Use the names of the inventory when one is given.
- Numbers are terms, never part of a name: Age(tom, 12), not AgeTwelve(tom).
- Facts are ground: Cat(tom). Rules: FORALLx (conditions IMPLIES conclusion); a conclusion may be a conjunction, a disjunction (Wet(x) OR Frozen(x)), or IFF for a definition. A condition may say "every": FORALLz (Needs(x, z) IMPLIES Has(x, z)). "No X is Y": NOTEXISTSx (X(x) AND Y(x)). Whatever is not stated or derivable is false.
- Quantities: Value(q, t) says quantity q is term t: a number from the problem, another quantity, or add(a, b, ...), sub(a, b), mul(a, b, ...), div(a, b), mod(a, b), pow(a, b), min(a, b, ...), max(a, b, ...), ceil(a), floor(a), round(a), abs(a). A percentage is its fraction (15% is 0.15). Build every computation from the problem's numbers. A value that depends on the case is a rule: (Member(ann) AND Ge(visits, 10)) IMPLIES Value(fee, 30).
- Conditions on numbers: Lt(a, b), Le, Gt, Ge, Eq, Ne between terms. A number the problem asks you to find from conditions gets no Value: write Integer(n) when it is a whole number, each condition as a comparison (Ge(n, 3), Le(add(n, 2), 10), Eq(mod(n, 4), 1)), Maximize(t) or Minimize(t) when the best choice is asked, and ? Ask(n).
- Order in time: Before(a, b), After(a, b).
- What the question asks is a QUERY: a formula starting with "? ". ? Ask(q) for an asked value; ? Gt(a, b), Ge, Lt, Le, Eq for an asked comparison; ? P(c) for a yes/no question; ? EXISTSx (P(x) AND Q(x)) for "which" or "is there"; ? FORALLx (P(x) IMPLIES Q(x)) for "do all". Query exactly what the question asks, not intermediate steps.
- A sentence without logic gets no entry.
Arguments and support (the claim below is a ground fact, facts joined by AND, or a rule FORALLx (A(x) IMPLIES B(x)) when the question is whether the rule holds):
- A rule is only what the text says holds in every case (if, every, always, only if, a definition); a pairing, a trend or a correlation the text reports is facts about the cases, not a rule.
- A formula is never an argument of a predicate: not Says(sam, Rained(x)), not Claim(ben, IMPLIES(...)), not Causes(Rain, Wet(x)). Write what a speaker claims as a SUPPOSE line, what the text states as facts and rules.
- An option is never a fact: an answer choice, a speaker's claim or inference, a rival story or explanation, a premise someone proposes to add. Write it as SUPPOSE label: formula, with a short lowercase label (the option's letter or the speaker's name). One SUPPOSE line is one fact or one rule. A step a speaker takes that the text's rules do not give (reading "if A then B" as "if B then A", or "if not A then not B") is a SUPPOSE rule.
- ? Effect(claim): which option strengthens, weakens or does not affect the claim; whether the premises prove, force or guarantee the claim; whether a speaker's conclusion follows.
- ? Explain(claim): which option or story explains the claim; what must be assumed for it.
- ? Missing(claim): why the claim does not follow; which premise is missing.
- ? Why(claim): why the claim holds (the rules that lead to it).
- ? Change(claim): what would change the answer about the claim.
- ? Assumed: what you assumed while translating.
- ASSUME formula: a fact or rule you add that the text does not state (the reading you chose for an unclear word, background knowledge the question needs). Never ASSUME what the text states, and never a number.

Example (another problem):
s1: A shop packs 48 eggs into boxes of 6.
s2: Each box sells for 2.5 dollars.
s3: How much money do all the boxes bring?
{"fol": [{"s": 1, "fol": ["Value(eggs, 48)", "Value(per_box, 6)", "Value(boxes, div(eggs, per_box))"]}, {"s": 2, "fol": ["Value(price, 2.5)"]}, {"s": 3, "fol": ["Value(income, mul(boxes, price))", "? Ask(income)"]}]}

Example (another problem):
s1: Depot rule: if a crate is sealed, it was weighed.
s2: Crate 7 was weighed.
s3: Ana says crate 7 is therefore sealed; Ben says a scale ticket was printed.
s4: Does the weighing prove that crate 7 is sealed? Why or why not?
{"fol": [{"s": 1, "fol": ["FORALLx (Sealed(x) IMPLIES Weighed(x))"]}, {"s": 2, "fol": ["Weighed(crate_7)"]}, {"s": 3, "fol": ["SUPPOSE ana: FORALLx (Weighed(x) IMPLIES Sealed(x))", "SUPPOSE ben: TicketPrinted(crate_7)"]}, {"s": 4, "fol": ["? Effect(Sealed(crate_7))", "? Missing(Sealed(crate_7))"]}]}

Inventory of this problem:
{{inventory}}

Sentences:
{{sentences}}
<<<again>>>
Your reply had these problems:
{{problems}}
Reply again with the whole corrected JSON object only.
