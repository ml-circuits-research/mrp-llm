# MRP formalize slot, CNL-ACE: the question rewritten in Attempto Controlled English (a repair round repeats it with APE's error)

## begin

### tier

small

### request

```json
{"maxTokens": 300, "temperature": 0}
```

### template

```text
Rewrite the QUESTION as ONE question in Attempto Controlled English (ACE), keeping its meaning exactly. Mark every content word with its class: p: for a proper name (p:Acme, p:Ana-Popescu with hyphens inside one name), n: for a noun (n:project), v: for a verb in the form the sentence needs (v:works, v:work), a: for an adjective. Keep the function words of ACE unmarked (who, what, which, how many, does, is, a, the, of, at, in, on, for, by, to, and, not).
ACE rules: one simple question; no contractions; no relative clause after a preposition; never end with a preposition (write "In which n:city is p:Globex v:located?", not "Which city is Globex located in?"); "of" relations use a noun ("Who is a n:parent of p:Carina?"); "how many" is followed by a plural noun.
Output only the ACE question.

QUESTION: ${message}${error}
```

### code

```javascript
this.end(result);
```
