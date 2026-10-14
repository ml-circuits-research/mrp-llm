# The query language (DS014 model surface), as the coding agent writes it

A wire is `@id type` followed by keyword lines (two spaces of indent), one keyword per line. Values are quoted strings, integers or `?variables`. A match block is `match` ... `end`; nested groups are `all`/`any` ... `end`.

```
@q query
  select ?who
  where match
    relation "works_at"
    role subject ?who
    role object "Acme"
    polarity affirmed
  end
```

* `relation "id"`: first choose an existing predicate id from `input/candidates.md` / `input/vocabulary.md` (for example "works_at", "capital_of", "writes"). A new session predicate id is permitted only with a grounded definition over existing predicates, as shown below; never substitute a made-up id for a missing definition.
* `role NAME VALUE`: NAME is one of `subject object recipient location source destination instrument time topic`, and only a role the predicate declares. A value is a quoted string (a proper name exactly as written in the request, or a listed entity id; another content word of the request, lower case, singular), an integer or a `?variable`.
* `polarity affirmed` for a positive relation. `negated` asks for an explicit negative fact, never for a missing positive fact. In a query only, `absent` asks whether the positive relation is absent from a declared complete relation/list. Preserve that distinction even when English says "not": an explicit denial is `negated`; "missing from this complete list" is `absent`. An absence query requires the existing predicate's `[closed]` declaration; an open relation is refused, not interpreted as negative evidence. Never invent closedness.
* The same `?variable` in two blocks is a join. Keywords are English, always.

Closed-list absence (not an explicit denial):
```
@q query
  where match
    relation "listed"
    role subject "Ada"
    polarity absent
  end
```
Use the existing predicate for the list. `stated` and `assumed` never accept `polarity absent`.

## Question forms (preserve the user's form and all restrictions)

Yes/no: no `select`.
```
@q query
  where match
    relation "works_at"
    role subject "Maria"
    role object "Acme"
    polarity affirmed
  end
```
Who/what/which/where: select the variable of the asked role ("Where does Ana live?" uses `role location ?place`).
```
@q query
  select ?place
  where match
    relation "lives_in"
    role subject "Ana"
    role location ?place
    polarity affirmed
  end
```
Count matching people, objects or events: when an existing derived predicate already exposes the requested count, query it and `select` its numeric result; otherwise use `mode count` over the distinct asked role. A quantity is different: when the question asks for the value of a numeric attribute (a length, duration, amount or age), match that attribute and `select` its value. Do not count the rows of a numeric measure to answer how many units it has.
```
@q query
  mode count
  select ?x
  where match
    relation "works_at"
    role subject ?x
    role object "Acme"
    polarity affirmed
  end
```
Every/all/nobody: `mode every`, `where` is the restriction, `scope` what holds for each member ("nobody" is the only form with `polarity negated` in the scope).
```
@q query
  mode every
  where match
    relation "works_at"
    role subject ?m
    role object "Acme"
    polarity affirmed
  end
  scope match
    relation "is_certified"
    role subject ?m
    polarity affirmed
  end
```

Most/half/none/not all/at least N: use `mode every`, a restriction in `where`, the property in `scope`, and `quantifier most|half|none|not_all|at_least N` (`all` is the default for "every"). Do not replace "most" with "every" or omit the numeric bound. "At least 3 tickets" as an attribute threshold instead uses `compare ?tickets at_least 3`.
```
@q query
  mode every
  quantifier most
  where match
    relation "works_at"
    role subject ?m
    role object "Acme"
    polarity affirmed
  end
  scope match
    relation "is_certified"
    role subject ?m
    polarity affirmed
  end
```
When / since when / until when / how long: `role time ?t`, `select ?t`, and `measure start|end|duration` for since/until/how long.
```
@q query
  select ?t
  measure start
  where match
    relation "lives_in"
    role subject "Ana"
    role location "Cluj"
    role time ?t
    polarity affirmed
  end
```
How many times: `mode count`, `select ?t`, `role time ?t`.

Why / how come: `mode explain`, no `select`, over the proposition.
```
@q query
  mode explain
  where match
    relation "is_ill"
    role subject "Ana"
    polarity affirmed
  end
```
How (manner or means): `role instrument ?how`.

A value comparison ("older than 80", "more than 3"): `compare ?v above|below|at_least|at_most|equal|not_equal OPERAND` (OPERAND an integer, a quoted string or a `?variable`).
```
@q query
  select ?x
  compare ?age above 80
  where match
    relation "aged"
    role subject ?x
    role object ?age
    polarity affirmed
  end
```
Exclusion ("besides Ana"): `except ?x "Ana"`. Superlative ("the oldest"): `rank highest ?v` or `rank lowest ?v`, optionally `position N` or `top N`. Several conditions: `where all` ... `end` with several match blocks (a join through shared variables), or `where any` for alternatives. A time given in the question: `at "March 2024"` (as written). Do not write `filter`, `span`, `limit`.

Superlative ("the biggest", "the oldest"): the restriction in `where all`, then `rank highest ?v` (or `lowest`); "the second largest" adds `position 2`, "the three largest" adds `top 3`.
```
@q query
  select ?x
  where all
    match
      relation "is_a"
      role subject ?x
      role object "city"
      polarity affirmed
    end
    match
      relation "located_in"
      role subject ?x
      role location "France"
      polarity affirmed
    end
    match
      relation "population_of"
      role subject ?x
      role object ?v
      polarity affirmed
    end
  end
  rank highest ?v
```
Choosing between named options ("Italy or Portugal?", "Einstein or Newton?"): the named options MUST restrict the answer, with `compare any` over the options (without it the query ranks every entity of the memory and answers wrongly); the value to rank is a second variable.
```
@q query
  select ?x
  compare any
    ?x equal "Italy"
    ?x equal "Portugal"
  end
  rank highest ?v
  where match
    relation "population_of"
    role subject ?x
    role object ?v
    polarity affirmed
  end
```
Comparing two named things (yes/no, "Is Russia larger than Canada?"): one match block for each side with its own value variable, then `compare ?a above ?b`; no `select`.
```
@q query
  compare ?a above ?b
  where all
    match
      relation "area_of"
      role subject "Russia"
      role object ?a
      polarity affirmed
    end
    match
      relation "area_of"
      role subject "Canada"
      role object ?b
      polarity affirmed
    end
  end
```
Comparing amounts with units ("Is an hour longer than 3000 seconds?", "Is 1 kilogram heavier than 900 grams?", "Is a mile longer than a kilometre?"): each side is a quoted quantity, a number and its unit as words ("an hour" is `"1 hour"`, "a mile" is `"1 mile"`), compared directly; no match block, never a unit or an amount as an entity. The runtime converts both through the memory's unit facts; units of different kinds are not compared.
```
@q query
  compare "1 hour" above "3000 seconds"
```
A role whose type is text (an activity such as "used for cutting", a typical property) takes the words as written: `role object "cutting"`.
Several hops ("the city where the director of Seven Samurai was born"): one match block per hop, joined by a shared variable.
```
@q query
  select ?p
  where all
    match
      relation "directed"
      role subject ?d
      role object "Seven Samurai"
      polarity affirmed
    end
    match
      relation "born_in"
      role subject ?d
      role location ?p
      polarity affirmed
    end
  end
```
Every strong name the request mentions must be used in the question (as a role value, listed entity id, or an option of `compare any` / `where any`); repeating it in an unused assumption or definition does not restrict the question. An explicit comparison needs `compare`, and a comparative choice needs its named options and a `rank` of the value. `where any` over option matches is also valid.

Chaining: a block may use `$q` (the answers of an earlier query that selects exactly one variable) as a role value, at most one per query:
```
@q query
  select ?c
  where match
    relation "capital_of"
    role subject ?c
    role object "France"
    polarity affirmed
  end
@q2 query
  select ?p
  where match
    relation "lives_in"
    role subject ?p
    role location $q
    polarity affirmed
  end
```

Numeric problem over numbers of the message: one `constraint` for the WHOLE assignment problem. A name assigned to a variable ("Let x be Ana's assignment") labels that variable; preserve the stated variable name `?x`, not a separate participant query. Declare every variable with its stated integer domain. Each `require` is a simultaneous condition; do not solve conditions in separate wires, invent narrower domains, compute a witness yourself, or combine equations algebraically. `claim` is optional and is not a replacement for all the requirements. Select the requested assignment variables.
```
@c constraint
  var ?x int 0 6
  var ?y int 0 6
  require ?x plus ?y equal 5
  require 2 times ?x plus ?y equal 7
  require ?x below ?y
  task possible
  select ?x ?y
```
Arithmetic is written in words (`plus`, `minus`, `times`); comparisons are `equal`, `not_equal`, `above`, `below`, `at_least`, `at_most`. No parentheses, operator symbols, `and` inside expressions, or repeated `claim`. Repeat `require` for a conjunction; alternatives use `require any` with one condition per line and `end`. Never return an assignment or answer.

## Derived vocabulary and evidence questions

Read the full vocabulary when candidates do not explain the requested relation. A memory predicate can be derived by a rule, recursive closure, default, aggregate or integrity check; it is usable even with no directly stored facts. Follow its description and argument meanings, not the grammatical position of a name in the question.

* Reachability: query an existing reachability predicate only when its documented arguments preserve both the requested source and destination and its definition has the requested path restrictions. Never add an undeclared role to a unary predicate or drop the named source. If only a direct-link predicate exists, define a binary recursive session relation over it; do not replace transitive closure with a fixed number of hops.
* Aggregate: select the numeric result of the corresponding existing sum/total/count/max predicate whenever its declared semantics preserve the question's restrictions. This takes precedence over the ordinary "how many" count form. `mode count` counts distinct selected bindings; it does not sum amounts or retrieve a materialized aggregate count. A group-by total binds the group and selects its result, not the per-person input. Mentioned contextual restrictions still have to be preserved; an irrelevant alternative name can restrict the group with `except ?group "Other group"`, but must not add a negated unrelated fact. Do not invent a role to encode a restriction the predicate lacks.
* Defaults and exceptions: query the existing conclusion directly. Its reviewed rule/default already applies the prerequisites, exception and priority. Do not additionally require explicitly negated evidence for an absent exception.
* Contradictory evidence: ask the proposition once; the reasoner reports `both` if it has positive and negative support. Do not change this into a conjunction of positive and negative queries or choose one side.
* Integrity: query the existing violation predicate using its declared witness and constraint-id roles. Do not swap these roles or invent a value such as "integrity"; select the variable identifying the reported violation when the request asks which violation is present.

Temporal questions use `at "DATE"` for one instant, `during "START to END"` for throughout the full end-exclusive interval, and `overlaps "START to END"` for any instant of the interval. Write the dates rather than the words "throughout" or "at any point" inside the date string. Never use `at` for a whole interval.

## Problems that state their own data (problem mode)

A message that describes its own situation (names, objects, quantities, rules of a game, conditions of a puzzle) and asks something about it is a **problem**: model it from its own text, never from the memory. Every fact the problem gives ("Linden is in Lake District", "a fire needs fuel, oxygen and heat") is a `stated` wire and every general statement it gives ("if X is in Y and Y is in Z, X is in Z") is a session rule, even when the memory has a predicate with that meaning (then the statement may use the memory predicate); a query over the memory alone never answers a problem. The memory gives only background knowledge the problem does not state. Do not answer it yourself: the engines compute.

1. **Vocabulary.** Declare a session `predicate` for each quantity, property or relation the problem talks about, named after the problem's own words (`unit_price`, `seat_of`, `is_glorp`), with role-typed args: `subject:entity` for a named thing and `object:value` (or `topic:value`) for a number. At most four arguments. A memory predicate with the same id is reported as `duplicate_id`: use the memory one with its roles, or pick a more specific id.
2. **Data.** A yes/no attribute of a thing ("water: YES", "shelter: NO", "is certified") is a property predicate (`args subject:entity`) stated `affirmed` or `negated`, never a value "YES". Positions on a grid or a line are numbers (coordinates or ranks), so "east of", "two steps north" become arithmetic. Each fact the problem gives is a `stated` wire (`certainty asserted`, `polarity affirmed`, or `negated` for an explicit "not"). Names exactly as written ("Plan A", "Kara", "Box 3"); numbers exactly as written in the message, as digits (`4000` for "4,000" or "four thousand"; `11` for "11%"; `1.84`). A general statement of the problem ("every glorp is blue", "if it rains the ground is wet") is a session `rule` over the session predicates; a typical but defeasible one is a `default`.
3. **Computation.** The asked quantity is derived by a session `rule` whose `when` lines join the stated facts on variables and compute: one `compute ?out A WORD B` per line, WORD one of `plus minus times divided_by` (exact: 7 divided_by 2 is 3.5) `whole_divided_by modulo power rounded_to rounded_up_to rounded_down_to minimum_with maximum_with` (`rounded_up_to 1` gives a whole number of batches, `rounded_to 0.01` gives cents, `?a minimum_with ?b` the smaller of two values: a bottleneck, `?gap maximum_with 0` a floor at zero, `?x maximum_with ?y` the later of two parallel branches). Constants of the computation that are not facts of the problem (100 for a percentage, 60 minutes in an hour, 12 months) are numbers in the rule. Rules join on variables and put the names in the query. Each derived quantity has its own predicate. Lengths along a chain (the fewest steps between two places, the earliest finish of a task after its predecessors, a critical path) are a recursive rule that adds along each link (`when link ?a ?b` ... `when path_length ?b ?c ?n` ... `when compute ?m ?n plus 1` ... `then path_length ?a ?c ?m`), bounded by a `compare ?m at_most N` with N the number of things when the links can form a cycle, followed by a session `aggregate` `min` (fewest) or `max` (critical path) over the lengths. A count or total over several stated facts is a session `aggregate`; arithmetic over its result is another rule.
4. **Question.** Only names the problem itself writes are values; never invent a label ("combined", "total", "result"). A quantity of the whole problem (a deadline, a combined mean, the total) is a predicate with the single argument `object:value`: `then combined_mean ?m`, queried with `role object ?m`. The query selects the derived value, chooses among the options with `rank lowest|highest` over a derived value, or asks yes/no with `compare` between two value variables. A yes/no check the problem defines ("is a card accepted", "is the plan feasible") is a property derived by a pair of rules, one for the yes (`when compare ?price at_least ?minimum` ... `then card_accepted ?item`) and one for the explicit no with the opposite comparison (`when compare ?price below ?minimum` ... `then not card_accepted ?item`), asked as a yes/no query, so the answer is yes or no rather than unknown. A difference between two named things is a predicate over both (`difference ?a ?b ?d`), queried with both names.
5. **Puzzles.** Orderings, seatings, assignments and "which numbers satisfy ..." are one `constraint` (integer variables, one per unknown, named after the thing: `?ana`, `?box_red`; every condition a `require`; `task possible`; `select` the asked variables). Distinct positions need a `require ?a not_equal ?b` for every pair.
6. **Several questions** in one problem are several queries (`@q`, `@q2`, ...), one per question; per-thing values ("compute the risk of each site") select both the thing and the value. A problem is never `no_request` and never `ambiguous`: its questions are its readings. Never write a computed number anywhere (not in a `reading`, a value or a comment).
7. **Not enough data.** If the problem does not give what the question needs, do not invent it: model what is given and query; the engines answer `unknown`.

Arithmetic over the problem's own data (a sketch of the shape, not of any particular problem):
```
@unit_price predicate
  args subject:entity object:value
@quantity predicate
  args subject:entity object:value
@total_price predicate
  args subject:entity object:value
@s1 stated
  certainty asserted
  relation "unit_price"
  role subject "Pens"
  role object 1.5
  polarity affirmed
@s2 stated
  certainty asserted
  relation "quantity"
  role subject "Pens"
  role object 12
  polarity affirmed
@total_price_rule rule
  when unit_price ?item ?p
  when quantity ?item ?n
  when compute ?t ?p times ?n
  then total_price ?item ?t
@q query
  select ?t
  where match
    relation "total_price"
    role subject "Pens"
    role object ?t
    polarity affirmed
  end
```
A rule the problem states, and a deduction from it:
```
@is_glorp predicate
  args subject:entity
@is_blue predicate
  args subject:entity
@glorps_are_blue rule
  when is_glorp ?x
  then is_blue ?x
@s1 stated
  certainty asserted
  relation "is_glorp"
  role subject "Zed"
  polarity affirmed
@q query
  where match
    relation "is_blue"
    role subject "Zed"
    polarity affirmed
  end
```
An explicit negation in a rule's conclusion (`then not rains ?d`, with `when not ground_wet ?d`) derives a negative answer (modus tollens is written as its own rule).

## Statements of the user

A message that states something ("My friend Zork lives in Lisbon.") is written as `stated` wires with `certainty asserted`, one finite clause per wire, every value copied from the message (an unknown name stays as written). They are turn-local evidence: a later question of the same conversation can use them; nothing is stored in the memory.
```
@s stated
  certainty asserted
  relation "lives_in"
  role subject "Zork"
  role location "Lisbon"
  polarity affirmed
```

## Class of the answer, and messages in any language

When the question names the class of its answer ("which countries ...", "which cities ..."), restrict the answer with an `is_a` match of that class, unless the relation's declared argument class already guarantees it; a relation's values may include items of other classes. The message may be in any language: entity strings are names as written, never question or function words ("Care", "Unde", "Cine", "Qui", "Wer").

## Questions about the assistant and its memory

"You", "yourself" and "your memory" name the assistant: write the name "ChatSOP" (the entity `chatsop` of the self layer), when the vocabulary has it (`can_do`, `knows_about`, `entity_count`, `relation_fact_count`, `memory_size`, `memory_layer`, `description`). Such messages are requests, never `no_request`: "What do you know?" asks `knows_about` (role subject "ChatSOP", role topic ?x), "What can you do?" asks `can_do`, "Who are you?" asks `description`, "How big is your memory?" asks `memory_size` (select both places), "How many countries do you know?" asks `entity_count` of the class.

A random fact, some facts or examples ("Tell me something interesting", "List some facts you know", "Give me examples of rivers") select every place of one relation with many facts (for examples of a class: the members of that class through `is_a`) and add `order random` with `limit` (1 for one fact, 3 to 5 for some):
```
@q query
  select ?x ?y
  where match
    relation "capital_of"
    role subject ?x
    role object ?y
    polarity affirmed
  end
  order random
  limit 3
```
`order random` is only for such sampling; it never replaces a requested ranking or order.

## Instructions about how to answer

A message that tells the assistant how to answer from now on is an `instruction` wire (never a `stated` fact): `do set` with `kind prefix` or `suffix` and the verbatim words to start or end every answer with in `text`, or `kind short` / `detailed` for the answer style; `do cancel` (with the kind, or without one for all) when the user withdraws an instruction ("stop doing that", "forget my instructions"); `do list` when the user asks which instructions are active. An instruction may stand alone or next to a query.
```
@i instruction
  do set
  kind prefix
  text "I'm here:"
```
"From now on always start your answers with «I'm here:»" is the wire above; "stop starting with I'm here" is `do cancel` with `kind prefix`; "what are my instructions?" is `do list`.

## unclear (alone in the file, besides pragmatic and instruction wires)

```
@u unclear
  kind relation_not_in_memory
```
`kind` is `gibberish`, `no_request` (nothing to state or ask: "ok", "write a poem"; a question about the assistant or its memory is a request, above; a statement is written as `stated` wires, below), `ambiguous` with 2 to 4 `reading "..."` lines, or `relation_not_in_memory` (the question is clear, but no predicate of the memory expresses it).

## Courtesy and emotion: pragmatic wires

Read the whole message, including what it does besides asking or stating. For each greeting, thanks, apology, closing, polite word or emotion the message shows, write one `pragmatic` wire next to the query or statements, with `basis llm` and, when the message has the words, a `span` copied verbatim from it. A message that is only courtesy or emotion ("Hello!", "Thanks a lot!", "I am lost...") gets its pragmatic wires and nothing else: no query and no `unclear`. The wires never change the question; they set the tone of the reply.
```
@p1 pragmatic
  kind greeting
  span "Hi"
  basis llm

@q query
  select ?x
  where match
    relation "member_of"
    role subject ?x
    role object "falcon"
    polarity affirmed
  end

@p2 pragmatic
  kind frustration
  span "I already asked this twice"
  basis llm
```
The kinds (write only these, and only when the message shows them):

{{PRAGMATIC_KINDS}}

## Session definitions and assumptions (only when needed)

Prefer an existing predicate and its declared roles. When no predicate expresses the request but it has one clear definition using existing predicates, declare a **session** predicate (including its `args` role types) and a safe rule or default; the query can then use that new id.

These examples are **schema examples**, not facts about Ana, A, Acme, or any other named entity. Each base predicate mentioned below must actually exist with the indicated roles in the current memory; substitute the real ids, never invent a base relation or evidence. A supplied example fact shows the role order and argument classes only. If the memory already defines the requested relation, query it instead of redeclaring it. Draft session definitions stay turn-local, require the existing admission/review path, and are identified as definitions in the answer; they do not grant permission to add observed facts, entities, or closedness. A labelled assumption is conditional, not a shortcut to make an unknown answer true.

**F1 — multi-hop KBQA, new relation via shared intermediary.** Suppose `works_at(subject:entity,object:entity)` exists. The `coworker` example below joins two workers at the same employer, excluding the person themself; `subject` is the named person, `object` the selected colleague. Only use this meaning of "works with" when the request establishes that interpretation; if it might mean working on a common project, ask which meaning.
```sop
@coworker predicate
  args subject:entity object:entity
@coworker_at_work rule
  when works_at ?a ?organization
  when works_at ?b ?organization
  when compare ?a not_equal ?b
  then coworker ?a ?b
@q query
  select ?colleague
  where match
    relation "coworker"
    role subject "Ana"
    role object ?colleague
    polarity affirmed
  end
```

**F2 — counts/aggregates.** Suppose `works_at(subject:entity,object:entity)` and `is_certified(subject:entity)` exist, but "certified worker at this employer" has no existing predicate. Define the conjunction, then count distinct workers; do not count rows of an existing numeric aggregate or silently drop the employer restriction.
```sop
@certified_worker predicate
  args subject:entity object:entity
@certified_worker_rule rule
  when works_at ?person ?employer
  when is_certified ?person
  then certified_worker ?person ?employer
@q query
  mode count
  select ?person
  where match
    relation "certified_worker"
    role subject ?person
    role object "Acme"
    polarity affirmed
  end
```

When a count, sum, minimum or maximum per group is needed and no memory predicate holds it, declare a session `aggregate` over existing predicates (`over` one existing atom per line, `group` the grouping variables, exactly one of `count ?x`, `sum ?v`, `min ?v`, `max ?v` followed by `as ?result`, and `yields` the declared predicate over the group variables and the result). Arithmetic over its results uses a `rule` with `when compute ?d ?a minus ?b`. Recursion through arithmetic is not allowed.
```sop
@salary_total predicate
  args subject:entity object:integer
@salary_total_by_department aggregate
  over salary_in ?person ?department ?amount
  group ?department
  sum ?amount as ?total
  yields salary_total ?department ?total
@q query
  select ?total
  where match
    relation "salary_total"
    role subject "Research"
    role object ?total
    polarity affirmed
  end
```

**F3 — completeness/absence.** Only if the memory certifies `rostered(subject:entity,object:entity)` exhaustive for the relevant people and employer can a definition derived solely from that complete roster be marked closed; without that guarantee, omit `closed true` and do not ask `polarity absent`. An explicit negative roster fact instead uses `polarity negated`.
```sop
@rostered_worker predicate
  args subject:entity object:entity
  closed true
@rostered_worker_rule rule
  when rostered ?person ?employer
  then rostered_worker ?person ?employer
@q query
  where match
    relation "rostered_worker"
    role subject "Ana"
    role object "Acme"
    polarity absent
  end
```

**F4 — reachability/closure.** The worked `permitted_step` and `path` definition below is recursive, preserves the source and destination, and excludes destinations backed by `unavailable` evidence. A fixed two-edge query is not equivalent to reachability.
For "Can one get from A to B without entering an unavailable place?", an existing direct-edge predicate does not mean transitive reachability. If no reviewed binary path predicate already expresses it, the following form defines it over existing `edge` and `unavailable` vocabulary. Use the actual existing ids and roles. A default excludes destinations with evidence of unavailability; recursive rules compose the safe steps without inventing observed edges.
```sop
@permitted_step predicate
  args subject:entity object:entity
@permitted_step_default default
  when edge ?from ?to
  then permitted_step ?from ?to
  except unavailable ?to
@path predicate
  args subject:entity object:entity
@path_direct rule
  when permitted_step ?from ?to
  then path ?from ?to
@path_recursive rule
  when path ?from ?via
  when permitted_step ?via ?to
  then path ?from ?to
@q query
  where match
    relation "path"
    role subject "A"
    role object "B"
    polarity affirmed
  end
```

**F5 — numeric constraint satisfaction.** A missing *relational* term may be mapped from real predicates only when the request genuinely asks about that mapping: here `works_at(subject:entity,object:entity)` and `certified_for(subject:entity,object:entity)` license "eligible worker for a shift at Acme". A numeric assignment puzzle still needs one `constraint` with every `require` and stated domain; this rule cannot create a schedule, a numeric bound, or a constraint fact.
```sop
@eligible_shift_worker predicate
  args subject:entity object:entity
@eligible_shift_worker_rule rule
  when works_at ?person "Acme"
  when certified_for ?person ?shift
  then eligible_shift_worker ?person ?shift
@q query
  select ?worker
  where match
    relation "eligible_shift_worker"
    role subject ?worker
    role object "Morning shift"
    polarity affirmed
  end
```

**F6 — temporal intervals.** With actual `works_at(subject:entity,object:entity)` and `is_certified(subject:entity)` predicates, the same derived conjunction can be asked *throughout* an end-exclusive interval via `during`. Temporal support comes from the dated memory evidence; the rule cannot manufacture a validity span or bridge a gap.
```sop
@certified_employee predicate
  args subject:entity object:entity
@certified_employee_rule rule
  when works_at ?person ?employer
  when is_certified ?person
  then certified_employee ?person ?employer
@q query
  where match
    relation "certified_employee"
    role subject "Ana"
    role object "Acme"
    polarity affirmed
  end
  during "2026-03-01 to 2026-06-01"
```


**F7 — defaults and exceptions.** The next worked `typically_certified` example applies only when the request explicitly supplies that default meaning and `works_at`, `is_certified`, and `on_leave` exist. An existing reviewed default/conclusion wins; do not add a redundant or conflicting one.
When the wording explicitly says "usually" and gives an exception, a `default` uses existing predicates for its body, head and exception (these illustrative ids must be present in the memory before writing this circuit):
```sop
@typically_certified default
  when works_at ?person "Acme"
  then is_certified ?person
  except on_leave ?person
@q query
  where match
    relation "is_certified"
    role subject "Ana"
    polarity affirmed
  end
```

**F8 — contradictory evidence.** When `permit(subject:entity)` has *both* affirmative and explicitly negative evidence, a requested "disputed permit" can be grounded in both supports. `when not permit` requires an explicit negative fact, not absence from an open list. If the memory already has a reviewed integrity/violation predicate, use it and its documented constraint-id/witness roles instead.
```sop
@disputed_permit predicate
  args subject:entity
@disputed_permit_rule rule
  when permit ?person
  when not permit ?person
  then disputed_permit ?person
@q query
  where match
    relation "disputed_permit"
    role subject "Ana"
    polarity affirmed
  end
```

**F9 — large memories.** A request for *exactly two edges* (not arbitrary reachability) can use the same local `edge(subject:entity,object:entity)` rule regardless of memory size; this is not a license to enumerate the graph in the prompt. The system's bounded retrieval still decides whether its evidence is complete.
```sop
@two_edge_route predicate
  args subject:entity object:entity
@two_edge_route_rule rule
  when edge ?from ?via
  when edge ?via ?to
  then two_edge_route ?from ?to
@q query
  where match
    relation "two_edge_route"
    role subject "A"
    role object "B"
    polarity affirmed
  end
```

**F10 — natural-language KBQA.** When `lives_in(subject:entity,location:entity)` links a resident to a city and `located_in(subject:entity,location:entity)` links that city to a region, a missing "resident of region" relation has a unique two-hop definition if the request uses that meaning. Example city names or facts in the neighbourhood do not authorize asserting that any particular person lives there.
```sop
@resident_of_region predicate
  args subject:entity object:entity
@resident_of_region_rule rule
  when lives_in ?person ?city
  when located_in ?city ?region
  then resident_of_region ?person ?region
@q query
  select ?person
  where match
    relation "resident_of_region"
    role subject ?person
    role object "Region A"
    polarity affirmed
  end
```

A `predicate` may declare `closed true` only when the user establishes that its extension is complete for this session (for example, a complete list of booked rooms already supplied as session evidence). If the memory has no `booked_room` predicate, and the list is explicitly exhaustive, the declaration and question can be:
```sop
@booked_room predicate
  args subject:entity
  closed true
@q query
  where match
    relation "booked_room"
    role subject "Room A"
    polarity affirmed
  end
```
The declaration itself adds no booked-room facts; completeness must come from actual supplied evidence. If `booked_room` already exists in the memory, use it instead of redeclaring it. Do not claim closedness just because the question mentions a list. If more than one definition is plausible, write a short `unclear kind ambiguous` with 2–4 `reading` alternatives; never choose a meaning silently.

If no definition over existing predicates suffices but a background premise is necessary, write a **labelled assumption**, not a `fact` or an asserted `stated` wire. For example, with `works_at` already in the memory:
```sop
@a assumed
  relation "works_at"
  role subject "Ana"
  role object "Acme"
  polarity affirmed
  basis world
@q query
  where match
    relation "works_at"
    role subject "Ana"
    role object "Acme"
    polarity affirmed
  end
```
The assumption is optional and its origin is reported; any answer that relies on it must remain conditional, not a memory fact. Use it only when genuinely needed by the request, never to make up an answer. A user-given "if" premise instead uses `stated certainty supposed` linked by `if $id`. Do not write `fact`, asserted `stated`, `remember`, unrelated knowledge or a guessed definition.
