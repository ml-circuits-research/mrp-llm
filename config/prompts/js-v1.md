<<<options>>>
{"mode": "problem", "output": "text", "maxTokens": 1200, "temperature": 0}
<<<system>>>
You write the computation of a problem as jsEval wires: pure expressions over the problem's numbers, evaluated by a reasoning engine. You never solve the problem yourself and never write a result you worked out: the engine computes it from your expressions. Reply with the wires only.
<<<user>>>
Problem:
{{problem}}

Numbers of the problem (given; an expression reads them as $v1, $v2, ...):
{{numbers}}

Write the computation of what the question asks as jsEval wires, one step per wire:
@name jsEval
  expr <one expression>

Rules:
- An expression reads only $v1 to ${{last}} and the names of earlier wires ($name). Never assign or restate $v1 to ${{last}}.
- The last wire is the answer. If several values are asked, name the wires answer1, answer2, ... in the order asked.
- Allowed: numbers, "text", + - * / % (remainder), parentheses, < <= > >= == !=, && || !, test ? a : b, arrays [a, b], records {name: "A", cost: $v1}, record.field, array.length, Math.min, Math.max, Math.floor, Math.ceil, Math.round, Math.abs, Math.pow, sum(array), count(array), count(array, x => test), min(array), max(array), range(n) (the whole numbers 0 to n-1), range(a, b) (a to b-1), array.map(x => ...), array.filter(x => ...), array.reduce((acc, x) => ..., start), array.sort((a, b) => a - b), array.includes(value).
- A function is an arrow with one expression as its body, written only inside map, filter, reduce, sort or count. No statements, no let or const, no loops, no functions of your own, no other methods.
- A percentage is already its fraction: for 15%, $vK is 0.15.
- A choice between named options answers with the option's text copied from the problem: $a < $b ? "the bus" : "the train".
- A yes/no question answers with a comparison or a test (true or false).
- Never write a number you computed yourself; write the expression that computes it.

Example (another problem: "Pens cost 3 dollars and notebooks 5 dollars. Ann buys 4 pens and 2 notebooks; Ben spends 30 dollars. Who spends more?"; v1 = 3, v2 = 5, v3 = 4, v4 = 2, v5 = 30):
@ann jsEval
  expr $v3 * $v1 + $v4 * $v2
@answer jsEval
  expr $ann > $v5 ? "Ann" : "Ben"

Example (another problem: "Three boxes weigh 12, 7 and 9 kg; a box over 8 kg costs 2 dollars to ship. How much does shipping cost?"; v1 = 12, v2 = 7, v3 = 9, v4 = 8, v5 = 2):
@weights jsEval
  expr [$v1, $v2, $v3]
@answer jsEval
  expr count($weights, w => w > $v4) * $v5
<<<again>>>
Your reply had these problems:
{{problems}}
Write all the wires again, corrected.
