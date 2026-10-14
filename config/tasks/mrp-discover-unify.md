# MRP discover slot, llm-consolidate: groups of synonymous candidate predicates

## begin

### tier

good

### request

```json
{"maxTokens": 1500, "temperature": 0}
```

### template

```text
You merge synonymous relation names of a value schema. Given candidate predicates with their descriptions and phrases, group the ones that mean the same relation with the same role order.
Return one JSON object and nothing else: {"groups": [["name_a", "name_b"], ...]}: only groups of two or more names; leave out every name that has no synonym.

CANDIDATES:
${candidates}
```

### code

```javascript
this.end(result);
```
