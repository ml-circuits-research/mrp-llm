# mrp-formalize-v1: the formalize slot, every strategy on the same questions

`acme.jsonl`: 40 English questions over the `acme-demo` base memory, written for this benchmark with hand gold (2026-10-14): lists, yes/no,
counts, rule-derived relations (grandparent), joins over two relations, casual wording, and six questions the memory cannot answer
(`gold: "unknown"`: the right outcome is an honest unknown, a clarification or an unclear reply, never a definite answer).
`commonsense.jsonl`: the 32 questions of `eval/commonsense/questions.jsonl` (gold true/false) over `commonsense-v1`.

A yes/no question whose gold is `false` asks about an open-world relation: `refuted` is correct, an honest `unknown` is not wrong.
Runner: `node tools/eval/mrp/formalize.mjs` (DS028 "Benchmark contract").
