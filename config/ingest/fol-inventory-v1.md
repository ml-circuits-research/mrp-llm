<<<inventory>>>
This passage is part of the document "{{title}}" (section "{{section}}"). Its sentences are statements, not a problem: write what each sentence states, as facts and rules. The whole document shares ONE vocabulary, given below. Use these exact predicate and constant names whenever the sentence means them (a CamelCase predicate here is the same as the snake_case relation of the vocabulary); write a new predicate or constant only for something no listed name means.

Predicates of the document (argument kinds in order; what it says):
{{predicates}}

Things of the document (constant: kind, "name as written", other ways the document refers to it):
{{constants}}

Values:
- A quantity of a thing is an argument of a predicate, not a Value: MaxSpeedKmh(bus_7, 80), not Value(max_speed, 80). Keep decimals as written (2.5). When a sentence uses another unit than the vocabulary's predicate, convert (2 years of membership is MembershipMonths 24: Lt(n, 24)).
- A quantity the document reports as such (a total, a part of a total, a budget line, a count, a limit) uses the shared relations when the vocabulary lists them: Amount(q, 120) and UnitOf(q, eur) for the quantity q, ComponentOf(part, total), UpperLimit(q, 500), LowerLimit(q, 10), StartsOn(x, 20250101), EndsOn(x, 20251231), Precedes(a, b).
- A share or a percentage is written in percent, never as a fraction: 40% is 40 (ShareOf(segment_a, market, 40)).
- A total, a count or a share of a whole belongs to the whole: never copy it onto each of its parts or members.
- A date is the number YYYYMMDD: 1998-06-03 and June 3, 1998 are 19980603. A year alone is the year (1998). The dates of this passage: {{dates}}
- Date functions (terms): months_between(d1, d2) is the number of complete calendar months from the date d1 to the date d2; years_between(d1, d2) the complete years; add_months(d, n) and add_years(d, n) the date n months or years after d. Example: FORALLx FORALLd FORALLn ((JoinDate(x, d) AND Eq(n, months_between(d, 20250101))) IMPLIES MembershipMonths(x, n)).
- A range "12 to 18 months" is two facts: a minimum and a maximum (DurationMinMonths(x, 12), DurationMaxMonths(x, 18)).
- A text value that is not a thing (a description, a title) is a quoted string: Motto(club_x, "Always ready").

Rules:
- A statement about a group (all employees of a kind, the members of a club, the items of a category) is a RULE over the group's members, never a fact about the group's name: "Senior members may borrow books" is FORALLx (HasMembershipLevel(x, senior) IMPLIES MayBorrowBooks(x)), not MayBorrowBooks(senior) and not SeniorMember(x). Pick the members out with the vocabulary's relations, so that the rule applies to the facts of the other passages; write a new one-place predicate for a group only when no relation of the vocabulary picks it out.
- A definition ("X is any ... who ...", "X is calculated as ...", "X is measured from ...") is a rule that derives X from the vocabulary's relations, never a text: "Membership length is counted in complete months from the join date to 2025-01-01" is FORALLx FORALLd FORALLn ((JoinDate(x, d) AND Eq(n, months_between(d, 20250101))) IMPLIES MembershipMonths(x, n)). Use the values the passage states in other sentences (a reference date, a period).
- A prohibition, a "never" or a negative statement concludes NOT: FORALLx (HasMembershipLevel(x, guest) IMPLIES NOT MayBorrowBooks(x)). When the document states an exception to a general rule, write the general rule and the exception as a rule that concludes NOT; the exception wins over the general rule.
- A yes/no property is a predicate without a true/false argument: MayBorrowBooks(x), never MayBorrowBooks(x, true); "no" or "never" is NOT of the positive predicate (NOT MayBorrowBooks(x)), never a negative name such as CannotBorrowBooks(x) or NoAccess(x).
- A general statement ("a loan is a debt", "every member pays a fee") is a rule, FORALLx (Loan(x) IMPLIES Debt(x)), never a fact about the category's name.
- A table row "column: value; ..." is one fact per column about the row's first cell, with the vocabulary's predicate for that column; a cell "yes" is the property itself, a cell "no" is NOT of it, a cell "none" or empty gives no fact.
- An example the document gives ("for example, a member who joined on ...") illustrates a rule: write the rule, not the example.
