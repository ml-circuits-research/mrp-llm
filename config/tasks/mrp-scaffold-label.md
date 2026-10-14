# MRP formalize slot, DependencyScaffold: name the predicate of a parsed relation from a closed list

## begin

### tier

tiny

### request

```json
{"maxTokens": 200, "temperature": 0}
```

### template

```text
A dependency parser read a question and found one relation between two arguments. Choose the predicate of the knowledge base that expresses this relation, from the CANDIDATES only, and say whether the parser's subject is the predicate's first role.
Return one JSON object and nothing else: {"predicate": "<an id from the candidates>" or null, "subject_first": true|false}.
Return null when no candidate expresses the relation.

QUESTION: ${message}
RELATION: ${phrase}
PARSER SUBJECT: ${subject}
PARSER OBJECT: ${object}

CANDIDATES:
${candidates}
```

### code

```javascript
this.end(result);
```
