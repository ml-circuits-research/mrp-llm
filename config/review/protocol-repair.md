## Input

The user message holds CONTEXT blocks (shared source passages) and ITEM blocks. Each ITEM has an id, a MATERIAL, and a WORK followed by PROBLEMS FOUND: the problems a reviewer and the validator reported for this work.

## Output (strict)

- For every ITEM write exactly one JSON object on one line.
- If you can fix it from the MATERIAL and CONTEXT alone: {"id": "<item id>", "work": "<the complete corrected work, with \n for line breaks, same format and same ids as the original>", "note": "<a few words on what you changed>"}.
- If a reported problem is not a real problem, return the original work unchanged in "work" and say why in "note".
- If the fix needs information that is not in the MATERIAL or CONTEXT: {"id": "<item id>", "work": null, "reason": "<one short sentence>"}.
- Change only what the problems require; keep every other line identical.
- After the last item write exactly this line: {"done": true}
- No code fences, no prose, nothing else.
