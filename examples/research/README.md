# Research usage examples

Six runnable examples of the declarative (small-model) surface, each in a different
topical domain. They demonstrate the *manner* of the external dataset designs we
adapt — question-to-proposition, polarity and temporal contrasts, ambiguity with
disambiguation — while the content is authored here. No external dataset row is
copied, and no model is called.

These six are syntax-and-behaviour demonstrations written for this repository, not
adaptations of external cases. The research corpora are the adaptation work: there,
each case keeps the domain of the source it is adapted from and varies only the
subject and wording, because a domain carries its own terminology, relations,
inference patterns and characteristic ambiguity.

```sh
node examples/research/demo.mjs
```

| # | File | Domain | What it shows |
| --- | --- | --- | --- |
| 1 | `proposition.sop` | employment and roles | question intent stated as a declarative `query`; the host compiles retrieval, reasoning and rendering |
| 2 | `polarity.sop` | IT infrastructure incident | one structural change (explicit negation) flips the answer: `supported` versus `refuted` |
| 3 | `temporal.sop` | project staffing contracts | the same question at a different evaluation time: inside the validity window `supported`, after the exclusive end `unknown` |
| 4 | `ambiguity.sop` | maintenance sites | a mention that is not unique in the scoped lexicon produces a host clarification with `pendingSop`/`required`/`next` |
| 5 | `spatial.sop` | geography and travel | containment question returning every matching site |
| 6 | `quantified.sop` | agriculture and food | a counted question (`mode count`) over declared entities |

Notes that the examples make explicit:

- A model target contains only `stated`, `assumed`, `unclear`,
  `query` or `constraint`, written as strings (`match` blocks with a relation phrase, roles and values as written); these examples use only `query`, and each file's header gives the message it formalizes. Rules, facts with
  provenance, resolution, packing, solving and rendering are host work; example 2b in
  `demo.mjs` supplies an approved rule as reviewed setup and shows the resulting
  derivation `depth` of `1`.
- Each scenario declares its own small ontology and fictitious knowledge, so the
  examples do not depend on the kinship fixture used by the CLI tests.
- Every claim above is asserted by the demo runner, so the file fails loudly if real
  behaviour changes.
