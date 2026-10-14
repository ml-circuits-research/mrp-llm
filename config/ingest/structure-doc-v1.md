<<<options>>>
{"output": "json", "maxTokens": 6000, "temperature": 0}
<<<system>>>
You extract the vocabulary of a passage of a document: the things it names, the kinds of relations and properties it states, its values, and how certain each sentence is. You never answer questions, never add knowledge the passage does not state, and never write logic. Reply with one JSON object only.
<<<user>>>
Document: "{{title}}". Section: "{{section}}".

Sentences of the passage (numbered; a table row is written as "column: value; ..."):
{{sentences}}

Vocabulary already known (reuse a name when the passage means the same thing or the same relation):
{{known}}

Reply with this JSON object:
{"entities": [{"name": "...", "kind": "...", "mentions": ["..."], "s": [1, 2]}],
 "relations": [{"name": "...", "args": ["...", "..."], "reading": "...", "one_value": true, "s": [1]}],
 "values": [{"text": "...", "type": "date|number|duration|range", "unit": "..."}],
 "certainty": [{"s": 3, "status": "hedged|reported|supposed"}]}

- entities: every specific thing the sentences talk about: a person, organisation, place, object, event, group, and every category value that things share (a branch, a membership level, a vehicle class, a class of things such as "senior member"). One entry per thing: "name" is its fullest name in the passage; "kind" is its class in one or two lowercase words (person, city, branch, membership level, vehicle, class); "mentions" are ALL the exact texts of the sentences that refer to it: other names, short forms, pronouns and descriptions ("the city", "it", "she"); "s" are the sentence numbers.
- relations: every kind of relation or property the sentences state, one entry per kind: "name" is a snake_case predicate made of words only, never of a value or number (located_in, birth_date, max_speed_kmh, may_borrow_books, founded_by); "args" gives the kind of each argument in order, with "number", "date" or "text" for a value (a property that the passage states for the members of a group, such as "senior members may borrow books", is a relation about one member: its argument kind is the member's kind, person, not the group; a unit belongs in the name, never in an argument: membership_months, not membership(person, number, unit); a yes/no property has no true/false argument); "reading" is an English template with X, Y, Z for the arguments ("X is located in the city Y", "X can reach at most Y km/h"); "one_value" is true when a thing has only one value of the relation at a time (a birth date, a total, an age), false when it can have several (a member of several clubs). A table column is a relation between the row's first cell and the column's value. A negative statement uses the positive relation (it will be negated), never a negative name such as not_member or no_access. Reuse the shared relations of the known vocabulary for a quantity's value, unit, parts, shares, limits, start and end dates and the order of events.
- values: every date, number with its unit, duration and range of the sentences, copied exactly ("1998-06-03", "June 3, 1998", "1,200 kg", "12 to 18 months").
- certainty: only the sentences whose content the passage itself presents as uncertain (hedged: "researchers believe", "probably", "is estimated"), as someone's claim (reported: "the company announced", "according to"), or as a hypothetical scenario the passage does not assert (supposed: "imagine", "what if", a condition the passage itself doubts). Plain statements of fact, and rules, permissions and prohibitions ("may", "must", "may not" in a policy), are not listed.

Copy every mention and value exactly from the sentences.
<<<again>>>
Your reply had these problems:
{{problems}}
Reply again with the whole corrected JSON object only; copy mentions and values exactly from the sentences.
