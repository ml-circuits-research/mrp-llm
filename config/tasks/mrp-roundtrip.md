# MRP roundtrip slot: restate the circuit in English; with judge, a model decides whether it asks what the message asks

## begin

### tier

small

### request

```json
{"maxTokens": 300, "temperature": 0}
```

### template

```text
You read a formal query or statement written in SOP Lang (wires: @name type, then indented "key value" lines; ?x are variables, quoted strings are names, "where p a b" means a condition p(a,b), "select ?x" means the answer asked for).
Restate in ONE plain English sentence what the user asked or stated, as the user would have said it. Output only that sentence.

SOP:
${sop}
```

### code

```javascript
const lines = String(result || '').split('\n').map(l => l.trim()).filter(Boolean);
this.restated = lines.length ? lines[lines.length - 1] : '';
if (!this.restated || !this.judge) this.end({restated: this.restated, verdict: null});
else this.next('judge');
```

## judge

### tier

small

### request

```json
{"maxTokens": 200, "temperature": 0}
```

### template

```text
Decide whether two English sentences ask or state the same thing (the same question about the same entities and relation; wording may differ). Return one JSON object and nothing else: {"same": true|false}.

A: ${english}
B: ${restated}
```

### code

```javascript
this.end({restated: this.restated, verdict: result});
```
