# MRP formalize slot, DirectSOP and SchemaGuidedLLM: one completion writes the whole query.sop (a repair round repeats it with the validator's problems)

## begin

### tier

small

### request

```json
{"maxTokens": 2500, "temperature": 0}
```

### template

```text
${system}

---

${user}${repairs}
```

### code

```javascript
this.end(result);
```
