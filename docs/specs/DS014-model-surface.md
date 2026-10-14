---
title: DS014-model-surface
summary: The circuit surface that the formalizer writes and the validator admits - stated, assumed, unclear, query, constraint and unparsed wires, clause links, KnowledgeLinker linking, the author boundary, and answer rendering.
---

# DS014 - Circuit surface: what the formalizer writes

## Scope

This specification is the normative contract of the **circuit surface**: the declarative language in which the formalizer writes a chat turn's circuits, and which the validator admits before anything executes. The pipeline of a turn is: the user message (in any language) -> the session's step-by-step formalization strategy (LocalLLMStepByStep by default: the system asks short questions, a Ploinky Workers tier answers them on the ladder `tiny`, `small`, `good`, and the system assembles the circuit; DS022 "Formalization strategies") -> the validator -> KnowledgeLinker -> StrategyRouter (`reasoning/router`) -> a reasoning strategy or the oracle (`js-reference`) -> deterministic English rendering from the result packet (`sop/answer-text.mjs`). `server/query-parser.mjs` runs the formalization step. One-shot authoring, where a model writes the whole circuit (LLMDirect), is archived (`probably_obsolete/one-shot-formalization/`, owner decision 2026-10-02); the surface below is what the step-by-step strategies assemble and what the validator admits from any source.

The proposition surface has six wire types: `stated`, `assumed`, `unclear`, `query`, `constraint` and `unparsed`; a seventh, the advisory `pragmatic` wire, records what the message does besides asking or stating (courtesy, emotion, small talk, a request to the assistant itself; since 2026-10-02, [DS023](specsLoader.html?spec=DS023-courtesy-and-emotion.md)); its `kind` is a message act the reply memory declares (`cv_act`, memory data since 2026-10-03, checked by the parser against the reply memory in use, not a list in code), and it is never linked, executed or used as evidence; an eighth, the advisory `instruction` wire (`do set|cancel|list`, `kind prefix|suffix|short|detailed|formal|playful`, the verbatim `text` of a prefix or suffix; since 2026-10-02, [DS023](specsLoader.html?spec=DS023-courtesy-and-emotion.md) "Behaviour layer", help page [docs/wire_typs/instruction.html](wire_typs/instruction.html)), records how the user wants the answers from now on and is applied to the caller-owned behaviour of the conversation, never to knowledge. A query-author output may additionally contain turn-local `predicate`, `rule`, `default` and `aggregate` session definitions under the author boundary below (`aggregate` since 2026-10-02, eval-generality-v1: a group-by count, sum, min or max over existing predicates is a definition like a rule). The formalizer never writes plumbing (`resolve`, `pack`, `solve`, `reason`, `cnl`, `remember`, `clarify`, `expand`, `value`, `jsEval`, `fact` or policy); the runtime generates the inspectable execution circuit for linking, resolution, collection, solving and rendering. The one exception is the jsEval route below, where the formalizer writes only `jsEval` wires under that route's own admission.

The tiny-model research branch (Stanza and UD-to-SOP rules, SymbolicLM, LanguagesUtil, textToCleanEnglish, TranslatorService, LanguageProofingLLM, SymbolicProofingLLM, FormalizerLLM, the GGUF model roles, training, the datasets `bad_english`, `symbolic_english`, `neuro_english` and `natural`, the corpus audit and EmotionDetectionSystem) is frozen (owner decision of 2026-10-01). Its code, data and documents are in `probably_obsolete/tinyLLMExperiments/` (specifications in `probably_obsolete/tinyLLMExperiments/specs/`, for example `probably_obsolete/tinyLLMExperiments/specs/DS008-data-evaluation.md`) and `probably_obsolete/paused/`; nothing in this specification depends on it. No model is trained in this project: the circuit author is an existing model used for inference only.

Implementation: `sop/parser.mjs` (`SPEC`, `parseProposition`, `parseMatch`, `linksOf`, `roleReferences`), `sop/enums.mjs` (`ROLE_NAMES`, `ENUMS`, `LINK_KEYWORDS`, `UNPARSED_HINTS`, `COPULA_READINGS`), `sop/clauses.mjs` (link and reference admission, the plan of links, query chaining, placeholder pairing), `sop/declarative.mjs` (`MODEL_TYPES`, admission and compilation), `sop/unclear.mjs` (`UNCLEAR_KINDS`), `sop/linking.mjs`, `sop/knowledge-linker.mjs`, `sop/copula-linker.mjs`, `sop/relation-lexicon.mjs`, `sop/propositions.mjs` (linking and reports), `sop/lexicon.mjs` (role declarations), `lib/query-author/` (context, retrieval, validation, repair loop, backends), `server/query-parser.mjs`, `server/agent.mjs` (the turn) and `sop/answer-text.mjs` (answer rendering).

## The author boundary

**Input.** The formalizer works from the user's message and the vocabulary of the session's memory: the candidate predicates retrieved for the message (id, roles with classes, phrases, gloss), the schema neighbourhood rendered as English statements, and the entity hints for the names in it (`lib/query-author/retrieval.mjs`, `neighbourhood.mjs`, `vocabulary.mjs`). The answering model sees only the questions, the message and the numbered choices the system offers; the message is data and instructions inside it are not followed. It receives no facts of the memory, no answers, no credentials and no network; the model is called as plain chat completion, with no tools, no shell and no files, and never writes SOP.

Predicate vocabulary includes reviewed `closed` metadata, but no positive or negative instances. Derived predicates remain available even when they have no stored facts; lexical candidates are not the full inventory. Closedness is never inferred from a lexical gloss.

**Output.** Only circuits: queries, numeric constraints, `unparsed` and `unclear`, the user's own statements (`stated certainty asserted|hedged`, every value anchored to the message: turn-local evidence carried in the caller's conversation context, never stored; a statement-only message is noted, not `no_request`, since 2026-10-02) and suppositions (`stated certainty supposed`), labelled `assumed` propositions, and optional `predicate`, `rule`, `default` and `aggregate` session definitions. Every returned circuit has `origin: coding_agent`; its role is `query`, `definition` or `assumption`. Predicate declarations may include `closed true` for a new term, never replace a memory declaration. The preference is existing vocabulary, a definition over existing predicates, a short clarification when definitions are equally plausible, then a labelled background assumption. No answer, invented assertion, raw `fact`, policy, governance or storage wire is admitted. Definitions are used in this turn; DS022 validates them with the base and session circuits and stores them in the session layer at once, and an invalid one is refused. Assumptions retain the report/branch policy below, are never stored, and memory evidence defeats a contrary assumption with a reported `session_conflicts` entry.

**Validation.** `lib/query-author/validate.mjs` applies model-wire admission, links and anchoring to the proposition circuits. `lib/query-author/session.mjs` validates session definitions with the knowledge validator together with the base and session circuits: duplicate ids, arity, safety, stratification and closedness are errors; every referenced predicate must be in memory or declared in this same output. New declarations extend the turn-local linking vocabulary, not the base lexicon. Strong unused name mentions, dropped explicit quantifiers, omitted direct comparisons and unrestricted comparative choices are errors, not advice. Problems make the step-by-step strategy re-ask the doubtful question for a bounded number of rounds, after which the turn is an honest `unclear` (DS022); phrase-mode vocabulary misses alone remain advice. A refused revision is reported and is never silently replaced by an earlier circuit.

**Numeric names and binding safety.** When the message explicitly binds a person's name to a numeric variable ("Let x be Ana's assignment"), that name is accounted for only when the variable is declared and participates in a requirement, claim or objective. A declaration or selection alone cannot hide a dropped named unknown. One named assignment has one constraint scope; splitting its conditions across independently solved wires is rejected. Repeated `require` fields are conjunctive; `claim` is one optional proposition when selected values are requested. The query author uses the existing derived vocabulary before rebuilding rules, and never treats an explicit negative as absence or a count of bindings as a sum. Selected, compared, ranked and excluded query variables must be bound by every alternative of `where`; omissions are returned for repair before execution.

**Archived one-shot mechanisms.** The constrained and structured decoders, the closed-JSON and free-string ablations, the answer-shape self-check round and the repair rounds of the one-shot author belonged to LLMDirect and are archived with it in `probably_obsolete/one-shot-formalization/` (2026-10-02); they are not part of the product.

**Availability.** If the first tier of the ladder is not available (Ploinky Workers unreachable, the tier not usable, or a timeout), or no tier could answer a question, the turn returns an honest `parse_unavailable` (HTTP 503); a run that ends with an invalid circuit is `parse_failed` (422, with the validator's problems). There is no fallback to another parser and no guessed circuit. Identical requests are cached per memory version, strategy and ladder.

**Language.** The message may be in any language; the formalizer reads it. Names are written as in the message; relation phrases and common nouns are written in English, normalized (lemmas, nominative singular), because the memory's vocabulary and the answers are English. The runtime reasons and renders in English; for a non-English message the answer is phrased in the user's language by a final formulation step after reasoning (DS009 "Answer language").

**Turn-local statements.** Asserted user statements are turn-local evidence kept in caller-owned conversation context; suppositions, reported speech and assumptions are used only conditionally or reported (see `stated` and `assumed`).


## Proposition form

`stated`, `assumed` and every query `match` block carry one proposition — one finite clause of the message — as keyword lines, one keyword per line.

| Keyword | Cardinality | Value | Meaning |
| --- | --- | --- | --- |
| `relation` | exactly once, required | one JSON-quoted nonempty phrase | The relation as meant, the lemma of the message's predicate words in English: `"work at"`, `"parent of"`. |
| `role` | 1–4 lines, required; a name at most once | `role NAME VALUE` | NAME is from the closed inventory `ROLE_NAMES` = `subject`, `object`, `recipient`, `location`, `source`, `destination`, `instrument`, `time`, `topic` (`role_unknown`, `role_duplicate`). VALUE is a JSON-quoted string — a proper name exactly as mentioned in the message, any other value normalized to English (see "The author boundary", Language) — or a safe integer; `$id`, another wire of this output (at most one per wire; see "Clauses and links"); in a query `match` also a `?variable`; in `stated`/`assumed` a `?variable` only as the placeholder of an `unparsed` span (see "Honest partial formalization"). Never a `~handle`, a bare identifier or quoted sigil text (`proposition_not_ground`). |
| `polarity` | exactly once, required | `affirmed` \| `negated`; query `match` only: `absent` | `negated` is explicit negative evidence. `absent` asks whether positive evidence is missing from a predicate declared `closed true`; on an open predicate it is refused (`absent_needs_closed`), never treated as negative evidence. `stated` and `assumed` cannot express absence this way. |
| `valid` | `stated`/`assumed` only; at most one line per form; optional | `valid on "TEXT"`, `valid from "TEXT"`, `valid until "TEXT"` | The temporal expression as stated in the message ("12 martie 2020"). `on` excludes `from`/`until` (`time_form`). Absent means timeless: the author states no time it was not given. |
| link lines | `stated`, `assumed` and `query` wires only (not inside a `match` block); 0–3 per wire | `because`, `so`, `if`, `unless`, `although`, `so_that`, `before`, `after`, `when`, `while`, each followed by exactly one `$id` | The relation of this clause to another clause of the message; see "Clauses and links". |

**Content words.** Every value and phrase follows the Language paragraph of "The author boundary".

**Time of a clause.** A statement's own time is written `valid on|from|until`; a question's time is its `at`, `during` or `asof` line (see "Question forms"). `role time` holds the `?t` variable of a when-question, or a time that the relation itself takes as an argument. A quoted `role time "…"` on a relation that declares no time role is read by the frame normalization (`sop/frames.mjs`, level `time`) as the statement's validity or the query's period, so both spellings link alike; the author writes `valid`, `at` and `during`.

**Values as written, relations as meant.** A proper name in a role value or a `speaker` is quoted exactly as the message writes it, typos and missing diacritics included; the runtime matches entity strings after case and accent folding and asks when a misspelled name does not resolve (it never resolves an identity by similarity). The relation phrase is the intended relation, normalized to a lemma when the message inflects or misspells it (`"work at"` for "wroks at", `"lucra la"` for "lucreaza la"). "Because of <entity>" is a role of the causal relation (`role topic` for the cause, `role source` for "from"/"de la"), and its preposition stays in the relation phrase like any other (C2): "Who did she quit because of?" is `relation "quit because of"` with `role topic ?x` (owner answer to Q-SYM-3); a "because" clause that is a whole proposition is its own wire, linked with `because $id` (see "Clauses and links"). Remarks about the user's own situation or purpose ("I have a meeting tomorrow", "My boss asked me") are not part of the problem and are not formalized.

**Linking.** After validation, the runtime repairs `unparsed` spans, applies the English synonym step (`sop/dictionary.mjs`, English view) and the KnowledgeLinker links each proposition (`sop/linking.mjs`):

1. *Relation.* The phrase is compared, after case and accent folding, with every lexicon predicate's identifier (underscores as spaces), labels, labels and lexeme forms and gloss (`description`). Auxiliaries and articles (`is`, `are`, `a`, `the`, …) are dropped and a plural or third-person `-s` and a final `-e` are ignored, so `"work at"` meets the alias `works at` and `"is a parent of"` meets `parent of`; other inflections (for example `-ing` forms) need a lexicon alias. Among the matching predicates, the role set decides: a `stated`/`assumed` proposition must bind exactly the roles the predicate declares; a query `match` must use only declared roles, and each unmentioned role becomes a fresh runtime variable. No match → `unknown`; several fitting predicates → `ambiguous`; matches with other role sets → `role_mismatch`. Each of these stops the turn with a runtime `clarify` (`reason: unresolved_link`) naming the candidates; nothing is guessed.
2. *Roles.* A predicate maps its argument positions to the inventory with `role NAME TYPE` lines (DS004 "Lexicon wires"; any other name is reported by the validator, `bad_role`). A predicate that only has legacy `args` is unnamed: with one or two arguments its positions are `subject` and `object`; with more it cannot be linked until roles are declared, and the corpus audit flags it.
3. *Values.* Quoted strings are resolved as entities of the argument's type by the generated `resolve` wires (exact, then accent-folded aliases; the existing identity rules of DS004). Unknown or ambiguous entities block dependent work and produce the existing runtime clarification (`reason: unresolved_dependency`). A numeral string fills an integer argument as a number.
4. *Time.* `valid`, and a query's `at`, `during` and `asof`, are normalized against the runtime clock: ISO dates and UTC timestamps, `YYYY`, `YYYY-MM`, an English month name or abbreviation with a year, a day, month and year ("3 March 2025", "March 3, 2025", "the 3rd of March 2025", "03.03.2025"), ranges "A – B" or "A to B" (from the start of A to the start of B), `now`, today/yesterday/tomorrow, last/this/next year (the calendar year of the runtime clock), with an optional leading preposition, including `from` or `throughout`. A trailing explicit year is shared with a named-month start that lacks a year: "April 1 to May 1, 2025" means `[2025-04-01, 2025-05-01)`, independently of the runtime clock. Year rollover is not guessed; invalid dates and non-increasing bounds require clarification. `on` is the whole period; `from` starts at the period's start; `until` ends, exclusively, at the period's start; `at` is the period's start; `during` is the period. Anything else becomes a `clarify` ("Which date or period do you mean by …?").

5. *Time variables.* In a query match block, `role time ?t` on a relation that declares a `time` role is an ordinary argument. On a relation without one it asks for the validity interval of the matched fact: the runtime drops the role from the atom and writes the runtime-only field `span ?t`, which binds `?t` to the interval (with several match blocks, the interval in which they hold together). A query with a span and neither `at` nor `during` looks at the whole timeline. With `order ?t1 before ?t2` each time variable is the interval of its own match block; the runtime writes `order ?t1 before ?t2 leaves I J` instead of `span` (see "Words, not operators").
6. *Quoted literals of `except` and `compare`.* A quoted value in `except ?x "Ana"` ("besides Ana") or in an `equal`/`not_equal` comparison is an entity as written; the runtime resolves it like a role value and asks when it is unknown or ambiguous. A compared string that names no entity ("2380 lei") stays a value. "the user" is linked to the caller's own entity when the caller-owned context supplies one (`context.user`, or the agent configuration `user`); otherwise it resolves like any other surface.

The linked result is the existing positional atom (`works_at maria lab_alpha`), preserving explicit `not` and query-only `absent` as distinct prefixes. The runtime bridge carries reviewed closed declarations into the oracle; an absence check cannot become an explicit-negative query.

An absence match binds no variables. Every variable it uses must be bound by evidence matches in the same conjunction, and all predicate roles must be supplied; omitted roles would introduce unsafe fresh variables. An `any` group supplies only variables bound in every branch.


## `stated`

A formalized report of one proposition that the user's message puts forward (the question and the attached assertions). Additional fields:

| Keyword | Cardinality | Values | Meaning |
| --- | --- | --- | --- |
| `certainty` | exactly once, required | `asserted` \| `hedged` \| `supposed` | The user's commitment: `asserted` (the user asserts it), `hedged` ("I think …"), `supposed` ("suppose …", "if …"). |
| `speaker` | at most once, default `user` | `user` or a JSON-quoted name | Reported speech ("Ion says that …"). |

No other field is accepted; in particular there is no `holds`, `quote`, `source`, `basis` or write field.

**Anchoring.** There is no quotation. The validator checks mechanically that every proper-name role value of a `stated` wire, and a non-user speaker, appears in this turn's message (question plus attached assertions): the value's tokens must match consecutive message tokens after case, whitespace and accent folding, each within a small edit distance (optimal string alignment: 0 for tokens up to 3 characters, 1 up to 7, otherwise 2) or as a short inflection sharing all but the last character of a token of at least four characters; a value that is another label or alias of an entity the message names also passes (`sop/linking.mjs` `mentionedIn`, `mentionedThroughLexicon`). Otherwise the turn is rejected with `stated_value_not_in_message`, and the author should use `assumed` or a query variable. The relation phrase is not anchored, because the author normalizes it. A `$id` value and a placeholder `?variable` are structural and are anchored through the wires they name; every `unparsed` span must be a verbatim part of the message after case and whitespace folding (`unparsed_span_not_in_message`).

**Semantics.**

| Statement | Lowered runtime value | Used by the generated `solve` as | Result marking |
| --- | --- | --- | --- |
| `certainty asserted`, speaker `user` | turn-local `fact … source user` | `data` (evidence) | not hypothetical |
| `certainty hedged` or `supposed` | turn-local `fact … source assumption` | `assume` (DS004 defeat semantics) | `hypothetical: true` when the proof uses it |
| any certainty with a `speaker` | turn-local `fact … source assumption` | `assume` | `hypothetical: true`; reported "According to …" |
| a supposition named by `if $id` (or `unless $id`) on a query | turn-local `fact … source assumption` (for `unless`, the negated atom) | `assume` of that query only | `hypothetical: true` when the proof uses it |
| a statement that carries `if`/`unless` itself, one with a `$id` role value, or one held by an unresolved `unparsed` span | none | not used | reported only (`treatment: conditional_statement`, `reported` or `incomplete`) |

User suppositions always take part in the primary result: the user authorized them. A supposition that a query names with `if`/`unless` applies to that query only; one that no query names applies to every query of the message. A contrary admitted fact or asserted statement defeats them exactly as DS004 describes, and the report marks `defeated: true`. Exact duplicates (same folded relation, role values, polarity and validity text, certainty and speaker) are rejected (`stated_duplicate`); contrary statements are accepted and the result exposes the conflict. Constraint problems do not consume statements.

**Lifecycle.** Authored → parsed → anchored → linked → lowered to a turn-local `fact` → consumed by this turn's generated `solve` wires → reported → discarded from execution state. A statement is never recorded by `remember` (none is generated), never published and never reinforced (local facts are excluded from proof-use promotion). Asserted user statements are carried across turns in caller-owned conversation context (`context.statements`, origin `user-statement`, linked atom, validity and the original input text) and re-supplied by the runtime as turn-local `fact … source user` evidence; they are not sent to the author. Hedged, supposed and reported statements are not carried. A statement-only turn returns `status: context_updated`.

## `assumed`

One proposition the model adds during intent detection. One wire type, no subtypes, no `certainty`; its values need not appear in the message. Additional field:

| Keyword | Cardinality | Values | Meaning |
| --- | --- | --- | --- |
| `basis` | at most once; optional, absent means `unspecified` | `closure` \| `default` \| `disambiguation` \| `implicature` \| `world` | Descriptive label: treating a list as complete; a typical case applied to this instance; a chosen reading of an ambiguous word, referent or scope (never an entity identity); a presupposition of the wording; general world knowledge. |

**Making an interpretation explicit (owner decisions Q-DATA-4 and Q-ARCH-1).** `assumed` is optional and need not be tied to the other wires. The author uses it to state the reading it chose whenever a message is vague or has several readings, so the choice is visible and reported:

- *An ambiguous word*: `relation "mean"`, `role subject` the words as written, `role object` the chosen reading, `basis disambiguation` ("Who made The Salt Road?" → `"made"` means `"wrote"`). The query keeps the words of the message; the KnowledgeLinker still links them and asks when they are ambiguous.
- *An ambiguous referent*: `relation "refer to"`, `role subject` the pronoun or description as written, `role object` the chosen antecedent as written, `basis disambiguation`. The convention is the subject of the preceding asymmetric sentence ("Ana manages Irina. Does she live in Cluj?" → `"she"` refers to `"Ana"`), and the query uses the antecedent. A pronoun with a single possible antecedent is resolved without an assumption. **Pronouns resolve backwards only**: the antecedent stands in the pronoun's own sentence or in an earlier one, never in a later sentence, so adding a sentence to a message never changes the wires of the sentences before it; a pronoun with no antecedent so far stays as written.
- *A presupposition of the wording*: "still", "again" and similar triggers presuppose an earlier state or occurrence; the assumption states that proposition with `basis implicature` and no validity (the message names no time). Such an assumption may restate the queried proposition; the corpora keep these cases few.
- *An ambiguity with no preferable reading* is reported instead with `unclear kind ambiguous` and its readings (see `unclear`).

**Ambiguity tolerance.** A genuinely ambiguous phrasing is never refused. When the readings are plausible formalizations of the same message ("Why is the gym closed?" is `mode explain`; "What is the gym closed for?" is `select ?x` with `role topic ?x`), the author writes one of them, and every plausible reading is correct for evaluation: a sealed case may carry the primary gold and the other accepted golds, and a prediction matches when it matches any of them. `unclear kind ambiguous` remains for ambiguities the author prefers not to resolve, such as a pronoun after two parallel clauses.

Assumptions that restate the queried proposition (closure, defaults, presuppositions) are allowed but not over-generated.

**Validation.** The proposition rules above apply. An assumption equal to a statement of the same turn is rejected as redundant (`assumed_duplicates_stated`); a contrary one is accepted. At most `policy.maxModelAssumptions` (default 8) are accepted; more reject the turn (`too_many_assumptions`).

**Semantics.** Runtime policy `modelAssumptions` decides the treatment; `basis` never influences trust, admission or reasoning.

| Policy | Linking and lowering | Effect | Report |
| --- | --- | --- | --- |
| `report` (default) | linked only for the report; an unlinkable assumption is reported with `predicate: null` and never blocks the turn | The primary answer is computed without assumptions. | `treatment: "reported"`, `used_in_proof: null`, `defeated: null` |
| `branch` | linked and resolved like a statement (an unknown or ambiguous string becomes a runtime `clarify`, so an assumption never chooses an identity); turn-local `fact … source assumption` consumed by a second generated `solve` per query, together with the user's evidence and suppositions | The primary answer is unchanged and assumption-free; the branch result is reported separately and marked hypothetical when its proof uses an assumption. | `treatment: "branched"`, `used_in_proof`, `defeated`; `assumption_branch` per query |

**Lifecycle.** Authored → validated → reported (and, under `branch`, linked and solved in the branch) → discarded. Never stored, never reinforced, never rendered with fact wording ("The model assumed: …"), never carried across turns; the author restates an assumption when it still needs it.

## `query`

A model query keeps the `query` fields of DS004 (`where`, `select`, `mode` (the five older modes and the five reasoning modes of "Question forms"), `at`, `during`, `asof`, `limit`; `filter` is trusted-circuit syntax that the author replaces by words) and adds `scope`, `measure` and the word fields `compare`, `except`, `rank`, `quantifier`, `order` and `fragment` (below), with two differences. Every `where` leaf is a `match … end` block holding one proposition (the keyword lines above, `?variables` allowed, no `valid`); `all`/`any`/`end` groups combine match blocks. An atom leaf is rejected (`query_needs_match`). `at`, `during` and `asof` take a JSON-quoted temporal expression normalized by the runtime. The canonical form nests the block lines under `match` and closes each block with `end`:

```sop
@q query
  where all
    match
      relation "works at"
      role subject ?who
      role object "Alpha Lab"
      polarity affirmed
    end
    match
      relation "member of project"
      role subject ?who
      role object "Delta Project"
      polarity affirmed
    end
  end
  select ?who
  at "2026-09-01"
```

`match` blocks belong to the model language; the trusted runtime only lowers linked atom queries.

### Question forms

Every question word has one formalization; the author writes the question it reads and never rewrites it into another form (owner decisions Q-DATA-1 and Q-DATA-2, 2026-09-28). The semantics are computed by the reference route (the oracle `js-reference` through `reasoning/bridge/reason.mjs`; the question forms are `js-reference/forms.mjs`, DS006 "The js-reference oracle"); a form without an interpreter would be answered `not_computable` with the formalization shown.

| Question | Formalization | Runtime semantics |
| --- | --- | --- |
| yes/no, "is it true that …" | `where` match blocks, no `select` (`mode exists` when variables occur) | status of the proposition: `supported`, `refuted`, `both`, `unknown` |
| who / what / which | `select ?x`, the asked role as `?x` | the bindings |
| how many | `mode count`, `select ?x` | distinct bindings |
| all / every / each ("Is everyone at X certified?") | `mode every`; `where` is the restriction (the domain), `scope` what must hold for each member, sharing its variables | `refuted` with `counterexamples` when a known member explicitly fails the scope; `supported` when every known member satisfies it and the restriction has a member; otherwise `unknown`. The check covers the members known to the runtime. |
| no / nobody / none ("Is nobody at X certified?") | `mode every` with a `negated` scope | as above; the determiner "no" is the only form written with a negated scope, and "all" is never rewritten as "nobody … not" |
| which groups have only … ("Which teams have only certified players?") | `mode every` with `select`; members are grouped by the selected variables | the groups whose members all satisfy the scope |
| is anyone … not … | `mode exists` with a negated match block | an explicit counterexample |
| when | `role time ?t` in the match block, `select ?t` | the validity interval of the matched fact (`span`) |
| since when / until when / how long | the same, plus `measure start`, `measure end` or `measure duration` | the interval's start, its end (`open` when ongoing) or its length in whole days up to the runtime clock |
| how many times | `mode count`, `select ?t`, `role time ?t` | the number of distinct validity intervals |
| where (where to, where from) | `role location ?place` (`destination`, `source`) | the bindings |
| how (means or manner: "How does Ana commute?") | `role instrument ?how` | the bindings |
| why / how come / how did … come to be | `mode explain` over the proposition (negated for "why not") | the status plus `explanation`: `derivation` (the rules and the facts they used), `recorded` (a recorded fact, no further reason) or `none` |
| why not / what is missing ("Why can't I hard-reset the router?", "What would make this true?") | `mode why_not` over the proposition or goal | the minimal base atoms whose addition would make the claim derivable plus the blocking atoms, or on a planning goal the blocking norm or requirement (`blocked`, `blocked_by`) |
| how do I / what are the steps ("How do I reset the router?") | `mode plan` with the goal as the match block | a sequence of actions reaching the goal under the norms in force |
| what could explain / which cause ("What could explain the outage?") | `mode abduce` over the observation | all inclusion-minimal explanations |
| did we follow the procedure / is this compliant ("Was the reset compliant?") | `mode conform` over the task; the performed trace is supplied by the runtime | `compliant` or `non_compliant` with the violated norms and deviations |
| what is the procedure for … ("What is the reset procedure?") | `mode procedure` over the task | the approved procedure as written, its version and the norms in force |
| conditional: "if P, is Q?" | `stated certainty supposed` for P and `if $p` on the query (`unless $p` for "unless P") | the answer under P, for that question only |
| what if a rule held ("would it follow if the rule also held the other way?") | the rule as a session `rule`, `if $r` on the query | the answer with that rule in force, for that question only (`conditional`) |
| which option strengthens / weakens / does not affect the claim; would the converse prove it | each option a `stated certainty supposed` or a session `rule`, `mode effect` over the claim with `candidate $id` per option | the claim without the options plus, per option, `establishes`, `blocks`, `contradicts`, `no_effect` or `inconsistent` ("Candidates: effect and abduce") |
| which story fits the signs; what does the argument assume | each story or premise a candidate, `mode abduce` with `candidate $id` lines | the minimal consistent sets of candidates that make the claim follow, and `necessary` (the candidates every set needs) |
| "why did you conclude X?" (introspection, fol-v3 `? Why(X)`) | `mode explain` on X | the proof, naming the rules used with their text |
| "what would change your answer?" (fol-v3 `? Change(X)`) | per premise X rests on, one `mode effect` query with that premise as its only candidate | per premise: the answer without it, and whether it `establishes` the answer (a premise the answer depends on) or has `no_effect` |
| "what did you assume?" (fol-v3 `? Assumed`) | the formalizer's `assumed` wires and assumed session rules, no question | the reported assumptions ("The model assumed: …") |
| a question about an earlier answer: "Who coaches X? And where does he work?" | two queries, the second with `role subject $q` | the join of both |
| a question bounded by a clause: "was it paid before the audit on 12 May?" | the clause as a `stated` wire with its time, `before $s` on the query | the query period until that time |

A claim check ("True or false: …") is a yes/no query and the claim is not `stated`; a conditional question links its supposition with `if`; several questions in one message are one `query` each; a numeric problem is a `constraint`; a message with statements only has no query (`status: context_updated`); `unclear` covers the unintelligible, the no-request and the ambiguous message. The wire help page `docs/wire_typs/question-types.html` gives one executed example of each question type, and `docs/wire_typs/model-guide.html` explains the language from the author's point of view.

`scope` is required by `mode every` and forbidden otherwise (`every_needs_scope`, `scope_needs_every`); `measure` needs exactly one selected variable written as `role time ?t` (`measure_needs_time_variable`); a query asks for at most one time (`time_variable_multiple`) unless `order` compares two; `order random` (a random sample with `limit`) belongs to mode `select` (`order_random_mode`); `mode explain` selects nothing (`explain_no_select`); `span` is runtime plumbing and is rejected in model output. Attribute values, comparisons, superlatives, quantifiers, temporal order and follow-ups have the word forms of the next section.

### Where the model and the knowledge meet

The knowledge the direct author writes from a source ([DS004](specsLoader.html?spec=DS004-sop.md) "Knowledge wires") and the question the author writes share only predicates and entities, and the KnowledgeLinker links them; the author sees identifiers only as the vocabulary lists them. The bridge is the roles of the `predicate` declaration: the author writes `role subject "Ann"` and `role object "Alpha Lab"`, the reviewed lexicon maps the relation phrase `"work at"` to the predicate `works_at`, and the predicate's `args subject:entity object:entity` says which position takes the subject and which the object; the entity resolution turns the strings into the symbols `ann` and `alpha`. A relation whose declaration has no roles cannot be linked (`args_without_roles`). The runtime links, StrategyRouter routes to a strategy, runs it under the budget and renders the packet:

```
user:   "If Ann worked at Alpha Lab, who works at Alpha Lab?"
model:  @s1 stated   relation "work at"  role subject "Ann"  role object "Alpha Lab"  polarity affirmed  certainty supposed
        @q  query    where match relation "work at" role subject ?who role object "Alpha Lab" polarity affirmed end
                     select ?who  if $s1
runtime:   predicate works_at (subject:entity object:entity); entities ann and alpha;
        @s1 fact holds works_at ann alpha status supposed;  @q query where works_at ?who alpha  select ?who  if $s1
packet: {status supported, rows [ann (conditional [s1]), bob], conditional [s1], used [...], strategy, route reason}
text:   "Ann, if she works there, and Bob."
```

The reasoning modes `why_not`, `plan`, `abduce`, `conform`, `procedure` and `effect` are question forms, not an authority to choose a strategy. The author never writes `via`, `trace`, `policy`, `amendment` or governance fields. Only the optional `predicate`, `rule`, `default` and `aggregate` definition layer is admitted through the knowledge validator; the proposition compiler still rejects knowledge wires. A `negated` match remains an explicit-negative query, even for a closed predicate; only `absent` requests absence, and an incomplete view cannot prove it. Closedness supplied in this turn is labelled as a coding-agent definition and expires with the overlay. `why_not`, `abduce` and `effect` are answered by the oracle (DS006 "Routing rules", R1; `abduce` over the memory's `hypothesis` wires or over the question's own candidates, consistent with the admitted facts; `effect` over candidates, "Candidates: effect and abduce" below), like `explain`, whose answer names the rules it used. A question mode without an engine (`plan`, `conform`, `procedure` on the model surface) is `not_computable`, with its formalization shown, never silently answered as `select`.


### Candidates: effect and abduce (Q-LANG-10, owner decision 2026-10-03)

Argument and metacognition questions ("which option strengthens the argument", "what does the speaker assume", "which story fits the signs", "would the converse of the rule prove it", logic book items of proposal P-1) are asked over **candidates**. The formalizer writes each option as a `stated` wire with `certainty supposed` or as a session `rule`/`default`, and names them on the question with `candidate $id` (repeatable, 1 to 8). It never states what supports what: no `claim`, `supports`, `undermines` or `assumes` wire exists, because that would be answering and no engine could check it.

- **`mode effect`** asks a ground claim (a `where` without variables, no `select`) without the candidates, then with each one, and the oracle classifies each candidate: `establishes`, `blocks`, `contradicts`, `no_effect` or `inconsistent` (DS004 "Query modes", DS006 `effects`).
- **`mode abduce` with candidates** returns the minimal consistent sets of candidates that make the claim derivable and `necessary`, the candidates in every set. Without candidates `abduce` keeps its meaning over the memory's `hypothesis` wires.
- **`if $r`** on a query may name a session rule or default of the same output: the rule is in force for that query only and the answer is `conditional` on it.
- **Not in force elsewhere.** A candidate and a session rule named by `if` enter only the runs of their query. A candidate statement applies to no other query of the turn; a candidate or `if`-named session rule is never in the session theory and is never stored (the admission hands it to the runtime as an `approval proposed` wire; `session_circuits` lists only the other definitions). Every run is hypothetical; strict knowledge beats defaults; `closed`/`absent` are unchanged; `at`/`during`/`overlaps` apply to every run.
- **Validator** (model surface, `sop/declarative.mjs`): `candidate_needs_mode` (only `mode effect` and `mode abduce` take candidates), `effect_needs_ground_claim`, `candidate_target` (the target is a `stated` wire with `certainty supposed` or a session `rule`/`default` of the same output, written as one `$id`, each named once), `candidate_also_if` (one wire is not both a candidate and an `if` condition), `candidate_limit` (at most 8), and `candidate_temporal_link` (the temporal links `before`, `after`, `when`, `while` do not combine with candidates). `if $r` naming a session rule is accepted only as `if` on a query (`link_target_type` otherwise).
- **Execution.** The js-reference oracle runs candidates; every other engine answers `not_expressible`, and the StrategyRouter sends these questions to the oracle (DS006 R1). A runtime that cannot run candidates (the plain `Runtime`) reports such a question `not_computable` rather than answering it without its candidates; the chat's `AuthorRuntime` runs them.
- **Answer.** Rendered from the packet by the conversation-v1 reply lines `line_effect_baseline_*`, `line_effect_<class>`, `line_effect_unfinished`, `line_candidate_rule` and `line_abduce_necessary` (no phrasing in code): "Without any of the options, it does not follow from what is known." / "With the rule "r_converse" (if …, then …), it would follow."
- **Formalizer (FOL path, role prompt `fol-v3`, 2026-10-03).** The formalizer writes these constructs in FOL and the converter (`lib/formalize/fol/`) lowers them; it never writes a candidate's effect itself. `SUPPOSE label: φ` is an option (an answer choice, a speaker's claim or inference, a rival story, a rule the text does not contain): each fact of φ becomes a `stated certainty supposed` wire and each rule a session `rule`, named `opt_<label>` (several under one label are tried one by one), and an option is a candidate of the support questions only, never in force in another question. `? Effect(claim)` is `mode effect` with every option as a `candidate`; `? Explain(claim)` is `mode abduce` over the options; `? Missing(claim)` (and Effect or Explain without options) is `mode why_not`. A claim is a ground fact, a conjunction of them, or a rule `FORALLx (A(x) IMPLIES B(x))` asked of an arbitrary instance (a new constant of which only A is given; withheld when a rule it rests on reads an absence). The answer these questions give the caller is whether the claim follows from the premises ("does not follow" when it is not derivable, withheld when a statement it rests on was not understood), plus the effects, the explanations or the missing facts.
- **Introspection (fol-v3).** The system reports on its own reasoning through the same constructs: "Why did you conclude X?" is `? Why(X)`, `mode explain`, whose answer names the rules used with their text; "What would change your answer?" is `? Change(X)`: for each premise X rests on (a stated fact or a rule, at most 8), one circuit whose `mode effect` query has that premise as its only candidate (the fact written `certainty supposed`), so the baseline is the answer without it and any effect other than `no_effect` names a premise the answer depends on; "What did you assume?" is `? Assumed`. The formalizer marks what it adds and the text does not state with `ASSUME φ`: a fact becomes an `assumed` wire (treated by the runtime policy `modelAssumptions`, reported, never a fact; a turn without a question lists the reported assumptions by the reply line `line_model_assumption`), a rule a session rule that every question resting on it supposes with `if $fa_r<n>` (at most 3 per question: `link_too_many`), so its answer is labelled conditional.

```sop
@rained predicate
  args subject:entity
@pavement_wet predicate
  args subject:entity
@r_card rule
  when rained ?m
  then pavement_wet ?m
@r_converse rule
  when pavement_wet ?m
  then rained ?m
@s1 stated
  certainty asserted
  relation "pavement_wet"
  role subject "market"
  polarity affirmed
@q_sam query
  mode effect
  candidate $r_converse
  where match
    relation "rained"
    role subject "market"
    polarity affirmed
  end
```

The answer: the baseline is `unknown` (Sam's conclusion is not forced) and `r_converse` `establishes` it: Sam is right only with the converse of the card's rule, which the card does not state (logic book item 171; executed by `tests/sop/query-candidates.test.mjs`).

## The jsEval route (owner decision 2026-10-03, proposal P-6)

A problem whose goal asks for a value or a choice computed from given data is formalized as `jsEval` wires instead of propositions. The route is chosen deterministically from the structure role's output (`lib/formalize/structure/route.mjs`): a `goal` span inside a question unit and at least one registry number (`lib/formalize/registry.mjs`) inside a `quantity` span; every other problem stays on the FOL route. No word of the problem is read by the decision.

- **What the model writes** (role prompt `config/prompts/js-v1.md`): `@name jsEval` wires, each with one `expr`, a pure expression of `sop/expression.mjs` over `$v1` … `$vn` (the registry numbers, a percentage as its fraction) and earlier wires. The runtime states the registry numbers from the message as values; the model never states a number or a fact. The last wire, or the wires `answer1`, `answer2`, …, are the answers.
- **Admission** (`lib/formalize/js-program.mjs` `admitJsProgram`): only `jsEval` wires with one `expr` (`js_route_type`, `js_extra_field`, `js_missing_expr`); new names, never `vK` or a callable name (`js_redefines_registry`, `js_reserved_name`, `js_duplicate_name`); the expression parses (`js_parse_error`); it reads only registry values and earlier wires (`js_unknown_reference`, `js_unknown_registry_index`), so there is no cycle, and no `?variable` (`js_variable`); every text literal is copied from the message (`js_text_not_in_message`); every answer depends on the registry through the dataflow (`js_answer_not_from_data`, the static data-dependency check); the interpreter evaluates every wire within its budgets (`js_runtime_error`); an answer is a number, a text, a yes/no or a list of them (`js_answer_shape`). One more ask names the violations; a program refused after it is reported, never replaced.
- **Lowering:** an admitted program is lowered, where its shape is fixed, to the arithmetic of the expression path (`lib/formalize/expression-program.mjs`) and from there to `stated` values and `compute`/`compare` session rules that every engine executes with a proof (arrays of fixed length, records with fixed fields, `range` of a literal bound, unrolled through `map`, `filter`, `reduce`, `sum`, `count`, `min`, `max`, `includes`; a fixed list answer is one answer per item). A program without a fixed shape (a `range` over data, `sort`, text methods, a list answer of data-dependent length) stays `jsEval` and is executed by the oracle (the trusted runtime's interpreter); the other engines answer `not_expressible` for it.
- **Not on this route:** recursion, graphs, paths and search (the engines' job, through rules and `constraint`), and every problem without registry quantities.

## Words, not operators (owner decisions Q-LANG-1 to Q-LANG-7)

**Principle (owner, 2026-09-28).** Every model construct stays as close to natural language as possible: keyword lines of words, no parentheses and no operator symbols (`?v > 80`, `?t1 < ?t2`, `?x != "Ana"` are never model output). The author does not reason or decide: it writes the best literal approximation of what the message says, and the runtime and the reasoner deal with the rest. The runtime lowers the words to its internal operators; trusted circuits may still spell the operators. Model admission rejects `filter` in a model query and any operator symbol (`< > = ! + * / % & |`, parentheses, a spaced `-`) in a model constraint with `operator_not_words` (`sop/declarative.mjs` `checkModelWire`).

| Message | Model form | Runtime semantics |
| --- | --- | --- |
| attribute value: "how much does X cost", "how old is X", "what time does X open" (Q-LANG-1) | a match with a value variable: `relation "cost"`, `role subject "X"`, `role object ?price`, `select ?price` (`role time ?v` for a clock time) | the bindings; the lexicon declares the attribute with an integer argument |
| comparison: "over 80", "more than 10 years", "older than Ion" (Q-LANG-1) | `compare ?v above 80`; comparators `above`, `below`, `at_least`, `at_most`, `equal`, `not_equal`; the operand is an integer, a JSON-quoted string or a `?variable` ("older than": two value matches and `compare ?a above ?b`) | each value is read as a number (a string that starts with a number, "2380 lei", counts as it); an ordering comparison with a non-numeric value is `not_computable`; a yes/no question whose known values all fail is `refuted` |
| comparison of amounts with units: "Is an hour longer than 3000 seconds?", "Is 1 kilogram heavier than 900 grams?", "Is a mile longer than a kilometre?" | `compare "1 hour" above "3000 seconds"`: both operands JSON-quoted quantities, a number (digits, optional decimal point) and a unit as words; the query needs no `where` | a quantity is read through the lexicon (an entity of class `unit`), never as an entity or a leading number; the comparison is lowered onto the predicates the memory declares with `reading unit_amount` and `reading unit_dimension` (`sop/quantities.mjs`): their facts for both units are matched (and cited) and the bound on the left unit's integer amount is the exact rational of the right side; units of different dimensions give no row (`unknown`), a quantity whose unit the memory does not know is asked about |
| superlative: "the cheapest", "the oldest" (Q-LANG-1) | `rank lowest ?price` / `rank highest ?age` | the rows with the best numeric value; ties keep all; no numeric value is `not_computable`; valid only over a complete view of the facts (over a partial slice the answer is `incomplete`) |
| ordinal and top-N: "the second largest country", "the three most populous cities" | `rank highest ?v position 2`, `rank highest ?v top 3` | `position N`: the rows with the N-th best distinct value; `top N`: the rows among the N best distinct values; ties are never split; a position beyond the distinct values gives no row |
| superlative of a class in a place: "the largest country in Europe", "the most populous city in Canada", "which country has the biggest area in Africa" | one query: `be a` with the class, `be in` with the place, the gradable adjective as an attribute match with a value variable (`relation "be large"`, `role subject ?x`, `role object ?v`; for "has the biggest area": `relation "have an area of"`) and `rank highest ?v` (`lowest` for "smallest", "shortest", "youngest", "least") | the linker maps the adjective to a measure through the lexemes of the memory (`config/knowledge/core-en/0200-measures.sop`: "be large" is `area_of`, "be populous" `population_of`); the language layer never decides which measure an adjective means |
| comparative choice: "Which is bigger, Canada or Brazil?", "Who was born first, Einstein or Newton?" | the attribute match (`role time ?v` for "born first"), `compare any` over the options (`?x equal "Canada"`), `rank highest ?v` | the option with the best value |
| nested description: "Where was the director of Inception born?", "the capital of the country where Einstein was born", "the population of the capital of France" | the inner noun phrase is a query of its own (`relation "be the director of"`, `role subject ?x`, `role object "Inception"`; for a `where` relative clause the clause asked as a where-question plus `be a` with the noun), written first; the outer question takes its answers with `role subject $q` | the runtime answers the chain; the last query is the answer. Only the question that asks for something nests (a variable in it); "Is Lin the author of X?" stays one fact, and a statement keeps its noun phrase as one value (C9) |
| age at death: "How old was Marie Curie when she died?", "At what age did Newton die?" | `relation "die at the age of"`, `role subject "Marie Curie"`, `role object ?age`, `select ?age` | the memory derives the age from the birth and death dates (`lived_years`, rule `r_lived_years` in `0200-measures.sop`); the language layer writes no event and no `when` link |
| superlative of a count: "who closed the most tickets", "cine a vândut cele mai multe bilete" (owner answer to Q-SYM-3) | written literally: the superlative stays in the relation (`relation "close the most"`), the counted noun is the value (`role object "tickets in the L2 queue"`), `select ?x` | `not_computable`: `rank` orders a numeric value, and ranking by a count has no engine |
| "besides Ana" | `except ?x "Ana"` | bindings where `?x` is another entity |
| a value among options: "at BT or UniCredit" | `compare any` with `?bank equal "BT"` and `?bank equal "UniCredit"` lines, then `end` (`all` groups and nesting as in `where`) | the bindings whose value is one of the options |
| quantifiers: "most", "half", "at least 3", "not all", "none" (Q-LANG-2) | `mode every` plus `quantifier most` (`all` default, `none`, `not_all`, `most`, `half`, `at_least N`) | over the known members: `all` as before; `none` supported when every member fails the scope; `not_all` supported by any failing member; `most` more than half supported; `half` exactly half supported with every member decided; `at_least N` at least N supported; an outcome the unknown members could change is `unknown` |
| a quantified statement ("most employees are certified") (Q-LANG-2) | formalized literally: `stated` with the quantified noun phrase as the value ("most employees") | linked like any value; no new construct |
| "before or after", "which happened first" (Q-LANG-3) | two match blocks with `role time ?t1` and `role time ?t2`, `order ?t1 before ?t2` (`after`, `same_time`); yes/no, or `select` when something else is asked | each time variable is the validity interval of its own match (no intersection); `before`/`after` compare the starts, `same_time` asks for overlap; unknown starts give `unknown` |
| "a random fact", "list some facts you know", "give me three examples of X" (sampling) | `order random` with `limit N` on a `mode select` query (`limit 1` for "a random fact"); `order random` alone asks for every answer in a random order | the same answer set as without the line, shuffled with the turn's seed and cut by `limit` (DS004 "Sampling"); the packet reports `sample {order, limit, of, seed}`; at most one per query, only in mode `select` (`order_random_mode`) |
| elliptical follow-up: "and Priya?", "dar anul trecut?" (Q-LANG-4) | `fragment follow_up` with match blocks that carry only what the message gives (`relation` and `polarity` may be missing) | completed from the previous query of the caller-owned conversation: a given role replaces the same role (or is added to the first match), a given relation or polarity replaces the first match's, a quoted `role time` becomes the query period; without a previous query the runtime asks "What would you like to know about Priya?". Not an `unclear` kind; the model decides nothing |
| first person: "I work at Acme", "my brother lives in Cluj" (Q-LANG-5) | values `"the user"` and `"the user's brother"`; everything stated about other people and the case is formalized | "the user" is the caller's entity when the caller-owned context supplies one (`context.user`), otherwise an unresolved surface (clarification) |
| modality: "is X allowed to sign", "can I park here" (Q-LANG-6) | the modal stays inside the relation phrase: `relation "be allowed to sign"`, `relation "can park"` | linked like any relation |
| advice: "should I negotiate", "is it worth it" (Q-LANG-6) | formalized literally: `relation "should negotiate"`, `role subject "the user"` | `not_computable` (runtime list `ADVICE_MODALS`: should, ought to, had better, be worth, be a good idea to, be advisable to), with the formalization shown |
| alternatives: "X or Y?" (Q-LANG-7) | one yes/no query per option (`@q`, `@q2`) | each option answered |
| arithmetic: "what is 19% of 2380 lei" (Q-LANG-7) | `constraint` in words, integers scaled by the author: `var ?vat int`, `require ?vat equal 2380 times 19`, `select ?vat`, `task possible` (hundredths); arithmetic words `plus`, `minus`, `times`, `divided_by` with the usual precedence (`times` and `divided_by` first, then left to right; no parentheses), exactly one comparator word per line, and `all`/`any`/`end` groups of such lines | `require ?v equal <numbers>` makes the runtime compute `?v`; a computation needs no `claim`; in a `constraint` (integer arithmetic over finite domains) `divided_by` and decimal numbers are `not_computable`. Since 2026-10-02 a problem's computations with decimals and division are session rules with `compute` ("Problems that state their own data", DS004 "Exact arithmetic") |

The runtime's `not_computable` answer repeats the formalization ("I understood the question as: …"), as for any problem without an engine.

## Conventions

Annotation conventions that close the under-specified details of a circuit (the step-by-step assembly follows them; the archived one-shot guide `probably_obsolete/one-shot-formalization/skills/coding-agent-query/` stated them for a writing model):

1. **Relation phrase.** The message's predicate words, lemmatized, keeping particles and prepositions ("work at", "move from"); an agentless passive keeps the passive with the patient as subject; modals stay inside the phrase ("be allowed to sign"). Against a memory vocabulary the phrase may be a predicate id listed for the request.
2. **Roles.** Membership of an organization or group is `object`; geographic origin is `source`; "because of X" is `topic`; "at/in a place" after a noun is `location`; means ("with a card", "by car") is `instrument`.
3. **Remarks and first person.** Facts about the user are `"the user"`; the user's own purpose, feelings, apologies and chit-chat are left out.
4. **Coordination.** Coordinated subjects or objects of a distributive predicate are one proposition each; an explicitly collective predicate keeps one conjoined value.
5. **Question forms.** The question-form table. Tag questions, embedded and imperative questions ("can you tell me", "list all") are the underlying query; alternative questions ("X or Y?") are one yes/no query per option.
6. **Relative clauses.** A definite description that names one thing stays one value; a question through a relative clause becomes match blocks that share a variable; a relative clause in a statement is its own `stated` wire.
7. **Certainty and speaker.** "I think", "probably" are `hedged`; "suppose" is `supposed`; "X says that" is `asserted` with `speaker "X"`.
8. **Numbers.** Plain integers are integers; amounts with separators, currency, units or decimals stay as written strings ("1.140 euro"); a leading number is read when it is compared, except in a comparison of two quantities whose units the memory knows, which is converted through its unit facts ("Question forms"). A value in a role the memory types `text`, `integer`, `value` or `rational` is never resolved as an entity (an activity such as "cutting" in `used_for`).
9. **Clauses.** One finite clause is one wire, never a string value; subordinate clauses are linked ("Clauses and links"); a connective that explains the user's asking is not a link.
10. **Unparsed.** A span that cannot be formalized is copied verbatim into an `unparsed` wire ("Honest partial formalization"); the understood parts are formalized normally.
11. **Unclear.** `gibberish` for unintelligible text, `no_request` for greetings, thanks and pure action requests without a checkable question, `ambiguous` only when no reading is preferable (otherwise `assumed ... basis disambiguation`).

## Problems that state their own data (owner 2026-10-02)

A message that describes its own situation and asks about it (a word problem, a puzzle, a logic exercise, a decision with given numbers) is a **problem**. The circuit author models it from its own text, never from the memory; the memory contributes only background knowledge the problem does not state. The author writes:

1. **Vocabulary**: a session `predicate` for each quantity, property or relation the problem talks about, named after the problem's words, with role-typed arguments (`subject:entity`, `object:value`, at most four). A quantity of the whole problem has the single argument `object:value`. An id that collides with a memory predicate is `duplicate_id`, and the message names the memory predicate's roles; a session id may share a form with a memory lexeme.
2. **Data**: one `stated` wire (`certainty asserted`) per given fact; names as written, numbers as written in the message as digits. Numeric anchoring is structural: a stated number is mentioned when the message writes the same number with or without thousands separators, as a decimal, or as a number word up to twenty (`lib/query-author/admit.mjs` `numberMentioned`). Asserted statements count as uses of the names they carry (`mention_not_used` reads them).
3. **General statements and computations**: session `rule` and `default` wires (a rule the problem states: "every glorp is blue"; modus tollens is its own rule with explicit negation), `compute` lines with exact arithmetic (DS004 "Exact arithmetic"), `aggregate` for counts and totals over the stated facts. Rules join on variables; constants of the computation (100, 60, 12) are numbers in the rule.
4. **Questions**: one `query` per question of the problem (selecting the derived value, ranking options by a derived value, or a yes/no comparison), or one `constraint` for a puzzle (orderings, seatings, assignments; integer variables named after the things). A solved constraint renders the values of its asked variables first; a value is given only when every solution agrees on it.

A problem is never `no_request`, `ambiguous` or `relation_not_in_memory`, and the author never writes a computed number. LocalLLMStepByStep reaches these circuits through its problem questions (DS022 "Problem mode").

## Clauses and links (owner decisions L1–L4)

**One finite clause, one wire.** The model splits a compound sentence the way clause analysis does ("analiza frazei"): each finite clause becomes its own short `stated`, `assumed` or `query` wire, and it never stuffs a whole clause into a string value. A subordinate or result clause is related to its main clause by one **link keyword line** `KEYWORD $id`, where `$id` names the related clause's wire. The keywords are the English conjunctions themselves, a closed set kept in one exported table (`sop/enums.mjs` `LINK_KEYWORDS`, so an experiment can swap it); each maps to one semantic type that the runtime acts on:

| Keyword | Type | English conjunctions | The linked clause must be |
| --- | --- | --- | --- | --- |
| `because` | `cause` | because, since (causal), as, given that | a `stated` or `assumed` wire |
| `so` | `cause` | so, therefore, that is why | a `stated` or `assumed` wire |
| `if` | `condition` | if, in case, provided that, assuming | a `stated` wire with `certainty supposed` |
| `unless` | `negative_condition` | unless | a `stated` wire with `certainty supposed` (the clause as written, not negated) |
| `although` | `concession` | although, even though, though | a `stated` or `assumed` wire |
| `so_that` | `purpose` | so that, in order to/that | a `stated` wire with `certainty supposed` |
| `before` | `before` | before, until (clausal) | a `stated` or `assumed` wire |
| `after` | `after` | after, once, since (temporal), as soon as | a `stated` or `assumed` wire |
| `when` | `during` | when, whenever | a `stated` or `assumed` wire |
| `while` | `during` | while, as | a `stated` or `assumed` wire |

**Placement.** The link line sits on the **main clause** and points at the clause the conjunction introduces ("the rollback failed because the migration is not idempotent": `because $s2` on the rollback wire). `so` is the one exception: it sits on the **effect** clause, the one "so" introduces, and points at its cause ("HID sent the wrong plates, so floor 3 is waiting": `so $s1` on the waiting wire). A link may name a wire written before or after it; references are resolved by name, and links and references form no cycle. On a `query`, the link qualifies the whole question ("if the invoice is paid late, is interest due?": `if $s1` on the query). Link lines are wire-level: a `match` block carries none. At most three link lines per wire.

**`$id` as a role value.** A role value may name another wire of the output instead of a string, at most once per wire:

- in `stated`/`assumed`, `$s` names a `stated`/`assumed` wire: that clause's proposition used as an argument ("is **that** fair", "…, **which** isn't OK there");
- in a query `match`, `$s` does the same, or `$q` names another query that selects exactly one variable: its answers (query chaining, "Who coaches CS Craiova? And where does **he** work?");
- in a `constraint` expression, `$q` is that query's single answer (a scalar).

A relative clause inside one question keeps the shared-variable form of C9; `$q` chains two questions of the message.

**Runtime semantics (L4).** The atomic propositions always execute as before; links add only what an engine can check, and report the rest:

| Construct | Runtime behaviour | `clause_links[].status` |
| --- | --- | --- |
| `if $s` / `unless $s` on a query | the supposition `s` (for `unless`, its negation) is consumed through `assume` only by that query; the answer is marked hypothetical when the proof uses it. A supposition that no query links keeps applying to every query of the message | `applied` (`effect: condition_scoped` or `negated_condition_scoped`) |
| `before`/`after`/`when`/`while $s` on a query, `s` with a readable time (a quoted `role time` or `valid`) | the query period becomes until the start of that time, from its start, or during it (intersected when there are several) | `applied` (`effect: until`, `from`, `during`) |
| the same, `s` untimed, or the query already has `at`/`during` | reported | `not_checked` (`reason: untimed`, `query_has_time`) |
| `because`, `so`, `although`, `so_that` on a query | reported with the answer ("Not checked: because: …") | `not_checked` (`reason: no_engine`) |
| any link on a `stated`/`assumed` wire | reported in the runtime sentence of the statement ("You stated: …, because: … [not checked].") | `not_checked` (`reason: statement_link`) |
| a statement that carries `if`/`unless` itself ("if it rains, the match is cancelled") | conditional: reported only, never evidence, never carried | `not_checked` |
| `$q` in a query | the runtime inlines `q`'s conditions, renamed apart, with a fresh variable in place of `$q` (a join); `q` is also answered | — |
| `$q` in a constraint | `q`'s selected variable as a projected scalar (DS004 `output ?x one`); several answers ask for clarification | — |
| `$s` in a query | `not_computable` with `understood_as` showing the referenced clause in brackets | — |
| `$s` in a `stated`/`assumed` wire | reported with `predicate: null`; never blocks the turn | — |

**Admission** (`sop/parser.mjs`, `sop/clauses.mjs`): `link_form` (a link line takes exactly one `$id`), `link_too_many` (more than three), `link_duplicate`, `reference_multiple` (more than one `$id` role value in a wire), `link_reference_unknown` / `reference_unknown` (no such wire), `link_self_reference` / `reference_self`, `link_target_type` (a link names a `stated` or `assumed` wire), `link_condition_not_supposed` (`if`, `unless` and `so_that` name a `stated certainty supposed` wire), `link_conflict` (one clause under both `if` and `unless`), `reference_target_type` (a statement's `$id` names a `stated`/`assumed` wire; a query's may also name a query), `reference_query_not_single` (a chained query selects exactly one variable), `link_cycle`.

## Honest partial formalization: `unparsed`

The author formalizes what it understood and says what it did not, instead of giving up or inventing (owner decision of 2026-09-29).

| Keyword | Cardinality | Values | Meaning |
| --- | --- | --- | --- |
| `span` | exactly once, required | one JSON-quoted string of at most 200 characters | A verbatim part of the message that the author could not formalize (`unparsed_span_form`); the agent guard requires it to occur in the message after case and whitespace folding (`unparsed_span_not_in_message`). |
| `near` | at most once | `$id` of a `stated`, `assumed`, `query` or `constraint` wire | The wire the span most likely belongs to (`unparsed_near_unknown`, `unparsed_near_type`). |
| `hint` | at most once | `subject` \| `object` \| `time` \| `location` \| `value` \| `relation` \| `reference` \| `other` (`UNPARSED_HINTS`) | The slot the span probably fills: a role, a value, the relation of the `near` wire, a reference to something said earlier, or other. |

**Target conventions (for the generator and the annotators).**

1. Formalize every understood part normally; add one `unparsed` wire per span that could not be formalized (jargon, an idiom, a garbled fragment, a reference to an earlier turn such as "aia", "el", "de mai devreme", "that one"). Several `unparsed` wires are allowed; two with the same span are not (`unparsed_duplicate`).
2. The span is copied verbatim: the shortest contiguous part of the message that carries the unknown slot, without the surrounding function words that the formalized part already covers.
3. When the span is the value of a role, that role holds a fresh placeholder variable (`role object ?x`, also in `stated` and `assumed`), and the `unparsed` wire names the wire with `near $id` and the role with `hint` (`subject`, `object`, `time`, `location`, or `value`/`reference`/`other` for any role when it is the only such span near that wire). An unpaired placeholder in a `stated`/`assumed` wire is rejected (`proposition_not_ground`). In a query, the placeholder is a non-selected variable of the role named by the hint.
4. When the span is the predicate, the wire keeps the author's best relation phrase (the message's words, normalized) and the `unparsed` wire has `hint relation` and `near` that wire.
5. The `unparsed` wires follow the wires they belong to. `unclear gibberish` and `unclear no_request` remain for whole messages only; an output may consist of `unparsed` wires alone when nothing could be formalized in a readable message.

**Repair (`sop/repair.mjs`), before linking.** For each span, in order: dates and times (the time normalization above); numbers, money and units ("12", "twelve", "1.140 euro" → `"1140 EUR"`, "2380 lei" → `"2380 RON"`, "12,5 km"); a reference to the conversation, resolved from the caller-owned context (the quoted values of the previous query) only when there is exactly one candidate; a proper name (capitalized words, or a surface the memory lexicon knows as exactly one entity). A `relation` span is tried as a relation phrase of its `near` wire during linking. A resolved span fills its placeholder and is reported in `repairs` (`unparsed`, `span`, `hint`, `near`, `wire`, `role`, `method`, `value`, `filled`). An unresolved span becomes **one targeted clarification question** ("Which date or period do you mean by …?") in `unresolved_spans` (`blocking` when a placeholder depends on it): only the wires that need it (and the queries that name them) are held back and reported as `treatment: incomplete`; every other question of the message is answered, and the questions follow the answers (`next: answer_clarification`). When every problem is held back, the turn is one clarification (`reason: unresolved_span`).

## `constraint`

A model `constraint` must state `task` (`prove` \| `possible` \| `optimize`): `prove` and `possible` give opposite readings of the same claim, so the choice is never a silent default (`constraint_task_required`). Trusted circuits keep the `prove` default. Constraints are numeric and need no linking. A model constraint writes its comparisons and arithmetic in words (`require ?x at_least 5`, `claim ?x equal 12`, `?a times 19`; see "Words, not operators"); a computation that `select`s its result needs no `claim`.

## `unclear`

| Keyword | Cardinality | Values |
| --- | --- | --- |
| `kind` | exactly once, required | `gibberish` \| `no_request` \| `ambiguous` \| `relation_not_in_memory` |
| `reading` | 2–4 lines with `kind ambiguous`, none otherwise | one JSON-quoted short paraphrase of a candidate reading, in the message's language (names as written) |

`relation_not_in_memory` is written only by the formalizer, which sees the memory's vocabulary ([DS022](specsLoader.html?spec=DS022-sessions-and-base-memories.md) "Request parsers"): the question is clear, but no predicate of the memory expresses it; the reply says so and the gap is logged for the authoring path. The author does not reason, so it reports only what it can recognise from the text: `gibberish` (unintelligible text), `no_request` (neither a statement nor a question: "ok", "thanks", a greeting, or a request for something unrelated such as "write a poem") and `ambiguous` (owner decision Q-ARCH-1): the text itself shows two or more readings and none is clearly preferable — a pronoun after two parallel clauses, a bare homonym ("Is the court free?"), the scope of "all … not", a prepositional-phrase attachment. When one reading is preferable the author resolves it with `assumed` (`basis disambiguation`) instead; resolved ambiguity is the common case. The scope of "all … not" ("All the invoices were not paid") is the exception: it is always `ambiguous`, with one reading for "none" and one for "not all", even when the rest of the message makes one reading likely, because choosing would need reasoning about the situation (owner answer to Q-SYM-3, 2026-09-29); an explicit "not all" or "none" is not ambiguous (`quantifier not_all`, `quantifier none`). The runtime lists the readings, numbered, after the fixed reply, and the packet adds `readings` and `next: 'choose_reading'` (`unclear_readings` rejects fewer than two, more than four, repeated, empty or unquoted readings, and readings on another kind). A semantically odd but readable message is formalized normally; the author does not judge contradictions, completeness or relevance. `unclear` must be the only wire of the output (`unclear_not_alone`). The runtime executes no circuit and renders the fixed reply for the kind from the single table `UNCLEAR_KINDS` in `sop/unclear.mjs` ; the packet is `{kind: 'unclear', status: 'unclear', unclear_kind, language, next: 'rephrase'}`. Renaming or adding a kind changes that table, this section and the help page only.

`unclear` differs from `clarify`: `clarify` remains runtime-generated and never authored by the agent (DS004); it asks for a relation, entity, date or scalar that the runtime could not link or determine for a formalized problem. `unclear` is the author's report that there is nothing to formalize.

## No refusal

The agent always formalizes a readable request; there is no agent-level `unsupported`. When no engine exists for a formalized problem, the answer is `status: not_computable` with `engine_status: unsupported`, `understood_as` (the one-line canonical formalization) and the reply "I understood the question as: .... I cannot compute this kind of answer yet."; a link without an engine is `not_checked`; `unsupported` is reserved for an explicit unavailable solver (AGENTS.md rule 8).

### The copula

"Is" has five readings, and the author writes each one so that the KnowledgeLinker can link it (owner request 2026-10-01, after "I do not know the relation 'be'" in the chat). The runtime side is the declared copula readings of the base memory (`reading class|occupation|attribute|identity|location|describe` and `describe_rank` on a `predicate` wire, `COPULA_READINGS` in `sop/enums.mjs`): the linker names no predicate itself.

| Sentence | Model form | Runtime reading |
| --- | --- | --- |
| "Who is Ada Lovelace?", "What is Python?" (identity, description) | `relation "be"`, `role subject "Ada Lovelace"`, `role object ?x`, `select ?x` | `describe` (ranked by `describe_rank`) |
| "Ana is a doctor.", "Is Paris a city?" (class membership) | `relation "be a"`, `role subject "Ana"`, `role object "doctor"`: the article inside the relation, like "be a member of", and the class noun without article as the object | `class` or `occupation`, tried in order (see "KnowledgeLinker: the copula and the relation lexicon"); never an unknown relation |
| "Paris is the capital of France.", "Who is the CEO of Acme?" (a role relation) | `relation "be the capital of"`, `role subject "Paris"`, `role object "France"` | an ordinary relation phrase: the predicate's alias (world-v1 `capital_of`) |
| "Ana is sick.", "Is Ion certified?" (attribute or state) | `relation "be sick"`, `role subject "Ana"` | an ordinary relation phrase (or the `attribute` reading) |
| "Ana is in Cluj.", "Where is Ana?" (location) | `relation "be in"` with `role location "Cluj"`; the question is `relation "be"` with `role location ?place` | "be in" is the alias of `located_in`; the bare "be" with a location role takes `location` |

A copula query normally writes the phrase and class string; it may use a predicate id from the retrieved vocabulary or its own validated definition layer. The memory, not the author, selects undeclared copula readings.

### KnowledgeLinker: the copula and the relation lexicon

The **KnowledgeLinker** (name pending the owner's confirmation; `sop/linking.mjs`, `sop/copula-linker.mjs`, `sop/relation-lexicon.mjs`) links the words of a message to the predicates of the chosen base memory. It is deterministic, never guesses beyond reviewed data and explains each reading it takes. The failure the owner saw ("I do not know the relation 'be'") was in this layer, not in the author's circuit: the parse (`relation "be"`, `role object "a doctor"`) was right, no predicate carried the string `be`, and the default base memory held no knowledge.

**What the code knows and what the memory declares.** The code knows six closed readings (`COPULA_READINGS`): `class` (Paris is a city), `occupation` (Ana is a doctor), `attribute` (Ana is happy), `identity` (Mark Twain is Samuel Clemens), `location` (Paris is in France) and `describe` (the facts that answer "Who is Ana?"); two further readings of the same list serve comparisons of quantities, not the copula: `unit_amount` (how many base units one of a unit is) and `unit_dimension` (what a unit measures; commonsense-v1 declares them on `base_amount` and `dimension_of`). It names no predicate. A base memory declares which of its predicates carry a reading on the `predicate` wire (`reading NAME`, repeatable, and `describe_rank N` for the order of the describing predicates), validated by `sop/lexicon.mjs` and by the knowledge grammar (`sop/knowledge/grammar.mjs`, `docs/wire_typs/predicate.html`). A memory without these lines answers honestly with a question; it never gets a guessed predicate. World-v1 declares its readings in its mapping table (`tools/world-kb/mapping.mjs`, `READINGS`).

**The relation lexicon** (`config/relation-lexicon.json`, loader `sop/relation-lexicon.mjs`) is reviewed language data, the only place such words live: the copula verb forms (`be`), the articles, the locative phrases (`in`, `located in`), the occupation nouns and the attribute adjectives (accent-folded), and `relations`, extra relation phrases a base memory maps to its own predicates (`{relation, lang, predicate}`; an entry whose predicate the memory does not declare is inert). The shipped file names no predicate (`relations` is empty); a base memory may ship its own file of the same shape, which extends it (`RelationLexicon.extend`). The lexicon is the review: a phrase it does not cover and no predicate alias covers stays `unknown` and the user is asked.

**Order of linking for one relation string.** (1) A predicate whose id, alias or description equals the phrase, then a relation-lexicon entry: `be the capital of` links to `capital_of` by its alias, `be in` to the memory's `located_in` alias; the roles must fit the declared roles. (2) Only when that does not bind and the string is a plain copula (`be`, `be a`, `be an`, `be in`, `be located in`), the readings below.

| Message | Model form | Readings tried, in order | Result |
| --- | --- | --- | --- |
| "Who is Ana?", "What is Paris?" | `be`, `subject "Ana"`, `object ?x` | `describe`: every predicate that declares it, by `describe_rank` then id | an `any` group over those predicates with the same `?x`; the answer is the union of their facts |
| "Ana is a doctor.", "Was Leonardo a painter?" | `be` with `object "a doctor"` (or `be a` with `object "doctor"`) | indefinite noun: `occupation` when the noun is an occupation noun of the relation lexicon, then `class` | statement: the first reading that has exactly one predicate (several: a question that lists them); question: all readings that have a predicate, as an `any` group, so the knowledge decides |
| "Ana is happy." | `be` with `object "happy"` | a one-argument predicate named after the adjective, if declared; else `attribute` | `tall ana`, or `has_property ana "happy"` in a memory that declares `attribute` |
| "Mark Twain is Samuel Clemens." | `be` with a capitalized name as object | `identity` | `same_as` of the memory |
| "Where is Paris?", "Is Paris in France?" | `be in`, `be located in`, or `be` with `role location` | `location`; the object role is renamed to the predicate's second role | the memory's location predicate |
| "Ana is not a doctor." | any of the above with `polarity negated` | as above | the same atom, negated |

Every linked copula is reported in the packet as `copula_readings` (wire, relation, the readings tried with the predicates each found, the reading taken, the alternatives), so the reading is inspectable. A definite noun phrase ("the doctor"), an unknown class noun or no declared reading never produce "unknown relation be": an unknown noun is an entity question ("Which entity do you mean by "flibber"?"); a definite phrase or a missing reading lists the declared readings ("Do you mean: Ana is a kind of "the doctor" or …?"); a memory without a describing predicate asks "Do you mean what Ana does, or who Ana is related to?"; a memory without a location predicate says so. Tests: `tests/linker/knowledge-linker-copula.test.mjs` (a hand-made knowledge base, author-shaped programs through the Runtime and the js-reference oracle).


### KnowledgeLinker: scoring and ambiguity

Since linking milestone M3 (`sop/knowledge-linker.mjs`, used by `sop/linking.mjs`, `sop/propositions.mjs` and `sop/declarative.mjs`) the KnowledgeLinker is a **scored, per-base-memory, joint linker**. The lexicon (the `predicate`, `lexeme` and `entity` wires of the memory's circuits, DS004 "Lexicon wires") is knowledge. For one proposition the linker builds the candidates of the relation phrase and of every role string and decides them together:

| Signal | Applies to | Score or effect |
| --- | --- | --- |
| form authority: a lexeme form, label, alias or id equals the phrase | relation | 100 |
| the memory's gloss of the predicate equals the phrase | relation | 90 |
| a reviewed relation-lexicon phrase reaches a predicate the memory declares | relation | 80 |
| the English synonym dictionary (`sop/dictionary.mjs`, English view): canonical form, other form, synonym, phrase of a nearby unparsed span | relation | 90, 85, 80, 70 |
| same head verb, other particles ("work for" for "work at"); queries only, never a stated or assumed proposition | relation | 50 |
| role class: an entity the message names in a role is of the class the role declares | relation, entity | +10; an entity of another class is a hard clash |
| `restrict ROLE CLASS` of the matching lexeme is violated by an entity of the message | relation | hard clash |
| the predicate's `domain` is the domain of an entity of the message | relation, entity | +3 |
| facts in the memory: only some of the equally good readings have `holds` facts (the lexicon counts them per predicate, `predicate.factCount`) | relation | decides (`facts`); the head-verb tier only offers predicates with facts |
| lexeme `weight` (1 to 10; no weight counts as 5) | relation | decides between equal forms; adds `weight - 5` to the reported score |
| a declared role a query leaves open | relation | -2 each |
| the entity is at least four times as notable as the next namesake | entity | +5; orders options, never decides alone |

Scores are integers so that reports can show them. The decision runs in named stages and the stage that decided is reported as `decided_by`: `only_candidate`; `constraint` (hard clashes removed all but one; a constraint never removes the last candidate); `form_tier` (the best form authority leads by `MARGIN` = 10); `facts` (only some of the equally good readings have facts in the memory: a predicate that cannot answer anything there loses to one that can); `weight` (distinct declared lexeme weights, which the lexicon validator demands for a shared form); `evidence` (class support and coherence lead by `MARGIN`); `class` (for entities, exactly one namesake is of the role's class); `form_tier` for entities too, only where the role expects a class (a role typed with a class, or the object of a predicate declared `reading class` such as `is_a`): a class whose id or label is the surface leads by `MARGIN` one that carries it only as an alias ("tool": the class `tool` before `device` with the alias "tool"). When the stages do not separate two or more candidates the linker returns an **ambiguity**, never a guess: a relation is `ambiguous` with its candidates (`required[].scored` lists their scores) and the question names them; an entity surface that names several entities becomes the issue `{kind: entity, status: ambiguous, candidates: [{id, label, class, score}]}` and the question reads "Which entity do you mean by "Paris": Paris (city) or Paris (person)?". The measured result (judged open-vocabulary questions on world-v1 with core-en; the numbers and their caveats are in the report of `eval-linking-v1`) is that merged vocabularies with parallel general and specific predicates are the main source of wrong links, not the scorer. A role that declares a class also accepts an entity of a subclass (`is_a` closure), bound by its id. Evidence about a particular entity (a fact of the predicate that mentions it) is not yet a signal; it needs the repository and belongs to the slice interface. The report entry of a relation also carries `facts`, the number of facts the memory holds for the bound predicate.

**Role relabeling, converse frames, frames, boundaries and names.** These rules close gaps between the words the author writes and the names the memory declares, all by principle and all reported:

- *Single-oblique relabeling* (`sop/propositions.mjs`). A memory names the roles of its predicates (`died_in` takes a `location`, `death_year` a `time`); the author may name a role by the preposition of the message. When a relation phrase reaches predicates whose roles do not fit, the linker looks for the case that exactly ONE used role name is not declared and exactly ONE declared role is not used, neither being the subject; that role is renamed. The rename counts only when exactly one renaming links the proposition (two readings are a `role_mismatch` as before). The `linking` entry of the relation carries `relabeled {from, to}`.
- *Frame tier* (`sop/frames.mjs`). When a relation phrase does not link as written (and is not a copula), the reviewed frames (synonyms and single-oblique role relabeling) rewrite the proposition before the synonym tiers, and the rewrite counts only when the lexicon then links it to a predicate that has facts. The packet reports `frame_changes` (`wire`, `from`, `to`, the individual `changes`, the `predicate`) and the `linking` entry has `via: frame`. The strict link (`dictionary: null`, or `frames: false`) never uses frames.
- *Converse frames* (`sop/knowledge-linker.mjs`, `sop/propositions.mjs`). A `lexeme` whose `frame` lists the object role first ("name of", "be the currency of") is a converse: when every applicable lexeme of the matched form is a converse and the clause has exactly a subject and an object, the two are swapped before the atom is built, the constraints are read again with the values in their new roles, and the swap stands only when the same predicate still binds. The `linking` entry carries `converse: true`.

**Chat turn and circuit rules.** The author runtime uses the base and session circuits plus this turn's provisional definitions as a cached `Theory`; generated query solves delegate to `askMemory` and `routedAsk`, just like the session query and evaluation harness. Rules with negated bodies or grouped conditions, defaults and aggregates therefore remain available rather than being lost in a typed-rule projection. Local evidence and linked suppositions are query-local fact wires; the knowledge validator checks the latter against the same predicate schema before use. Suppositions are consumed only through `assume`, and an unconsumed or evidence-fed assumption remains an error. Nested-query role classes retain the declarative compiler's subclass unification. Comparison equality domains bind retrieval constants before the comparison filters rows (`equalityDomains`, `bindDomains`), so named choices do not require fetching every entity.


**Conversation entities (owner decision 2026-10-01).** A name in a user statement that no label or id of the memory carries, and that matches only the alias or name part ("Maria", "Einstein") of entities with a declared `notability` (an open-world memory such as world-v1, where aliases are altLabels; a curated world declares its aliases on purpose, so there an alias stays a reference), introduces a conversation entity `local_<name>`; it takes precedence over a memory namesake and is never merged with it (the linking entry has `via: conversation` and lists the `shadowed` memory entities). The same name in a later question refers to it while the conversation carries a statement about it (caller-owned context, nothing is stored); a memory entity with that exact label always wins, and without a statement the alias reaches the memory entity as before. A proper name the memory does not know at all also introduces a conversation entity when a user statement names it (a common noun such as "a flibber" stays an entity question) (2026-10-02, eval-generality-v1: "My friend Zork lives in Lisbon." then "Is Zork in Portugal?"); in a question, an unknown name that no carried statement introduced stays an entity question. A name a statement of the **same** model output introduces is the same conversation entity in that output's questions and in its session definitions (2026-10-02, problem mode: "Plan A costs 400 ... Which plan is cheaper?"; a quoted constant of a session rule that names it is rewritten to its symbol at execution, `lib/query-author/runtime.mjs`). **Name parts.** The lexicon build adds the last word of the English label of a person ("Einstein" for "Albert Einstein") as an alias flagged `derived: name_part` (generic: every entity of kind `person` with a multi-word label, no per-name data); a surname alone therefore yields the candidates, the notability stage decides when one is far more notable, otherwise the clarification lists them with their descriptions.

**Report.** Each `linking` entry of the packet gains `score`, `decided_by` and `scored_alternatives` (`[{id, score, tier, weight?, rejected?}]` for a relation, `[{id, score}]` for an entity); the existing fields (`wire`, `kind`, `surface`, `symbol`, `via`, `form`, `match`, `class`, `alternatives`) keep their meaning, so consumers of the report are unaffected. The chat panel shows "score 100 by only_candidate; alternatives: manages_team (110)".


## Packet and trace fields

Every chat packet and the `chatSop` trace carry `parse: {parser, model, backend, rounds, cost_usd, ms, cache, ...}`: the coding-agent record of the turn ([DS022](specsLoader.html?spec=DS022-sessions-and-base-memories.md) "Request parsers"); when no model is available the turn carries `parse_unavailable` with the reason. The sections below describe the fields of the shared path.

A model-origin turn adds to the result packet:

- `user_statements`: one entry per authored `stated`: `id`, the authored `relation`, `roles`, `polarity` and `valid_text`, the linked `predicate` and `atom`, the normalized `valid {from, until}`, `certainty`, `speaker`, `treatment` (`evidence` \| `supposition`), `conditional`, `in_circuit`, for suppositions `used_in_proof` and `defeated`, and the runtime-rendered `statement` repeating the author's strings ("You stated: works at (subject: Maria; object: Alpha Lab).", "You stated tentatively: …", "You supposed: …", "According to Ana: …").
- `carried_statements`: asserted statements supplied from earlier turns.
- `model_assumptions`: one entry per `assumed`: the same fields, `basis` (or `unspecified`), `treatment`, `used_in_proof`, `defeated`, `statement` ("The model assumed: …").
- `assumption_policy`: `report` or `branch`; `assumption_branch` under `branch`: `{problem, status, answers, hypothetical, defeatedAssumptions, route, text}` per query.
- `origins`: used step ids labelled `memory`, `coding_agent` (`kind: definition|assumption`) or `conversation` (`kind: statement|assumption`).
- `session_conflicts`: defeated assumption ids, original circuit id, origin, atom, `status: defeated` and `reason: memory_wins`.
- `effects`, `necessary`, `candidates` (modes `effect` and `abduce` over candidates): the oracle's fields by the ids the model wrote, each candidate `described` (a statement's atom, or a rule's conditions and conclusion) for the renderer.
- `session_circuits`: provisional definition text with `origin: coding_agent`, and `scope: turn`; no fact or assumption is persisted by the report itself (a valid definition is stored in the session layer by DS022).
- `parse.self_check`: shape `{status, cardinality, circuit}`, `status: unchanged|revised|invalid|unavailable`, and `revised`; answer values are absent.
- `clause_links`: one entry per link line: `from`, `keyword`, `type`, `to`, `status` (`applied` or `not_checked`), `effect` or `reason` ("Clauses and links"); statements carry their own `links` and a runtime sentence that names them.
- `linking`: one entry per bound mention, in wire order: `wire`, `kind` (`relation` or `entity`), the `surface` as written, the `symbol` it was bound to and `via` (`lexicon`, with `form {kind lexeme|label|alias|id|description, text, language}` for a relation and `match` `exact` or `accent-folded` plus the `class` for an entity; `copula_reading` with the `reading`; `synonym` or `unparsed_span` with the `form` the phrase was normalized to), and for a relation the `alternatives` not taken (the other readings of a copula). Since M3 each entry also carries `score`, `decided_by`, `scored_alternatives` and, for a relation, `facts` ("KnowledgeLinker: scoring and ambiguity"). A relation whose role was renamed carries `relabeled {from, to}`, and one linked by a frame has `via: frame` (the packet lists `frame_changes`). It lists what the KnowledgeLinker decided from the lexicon of the session's base memory (DS022 "Lexicon of a memory"), so the chat trace shows "work at" linked to `works_at` by the lexeme form "works at"; an unlinked or ambiguous mention is not listed, it is the clarification.
- `repairs` and `unresolved_spans`: the symbolic repair of `unparsed` spans and the one question per unresolved span ("Honest partial formalization").
- A runtime link failure returns `status: clarify` with `reason: unresolved_link` and `required` listing each unlinked relation (`status`, `candidates` with their roles) or time expression; a turn whose every problem waits for an unresolved span returns `reason: unresolved_span`.

When a primary result is hypothetical, the controlled text lists each conditional statement it rests on ("Condition: …"); under `branch` it adds "Only under the author's assumptions: …". The HTTP trace (`chatSop`) carries `user_statements`, `carried_statements`, `model_assumptions`, `assumption_policy`, `assumption_branch`, `unclear`, `understood_as` and `linking`, next to the existing fields; the packet carries `clause_links`, `linking`, `repairs` and `unresolved_spans`.

## Answer rendering

The English text of an answer is written from the result packet by fixed templates (`sop/answer-text.mjs`, used by `cnl`; no model, the structured packet is unchanged). A wh-question answers with its values and readable labels (`Answer: Paris.`, `Answers: person and mathematician.`; a class is not capitalized, a class already implied by another listed class is dropped, a description from the memory is shown as `Described as: ...`, more than eight values end with `and N more`); a count says `At least N; the exact number cannot be given because the search was not exhaustive.` when the retrieval is incomplete; a yes/no question answers `Yes.` or `No.` (an explicit negation) or `The available information does not decide the question, so I don't know.`. The justification is a short list of the facts that support the shown answers, each as a sentence with its origin label (`stated in this conversation`, `assumed`, `definition`, `memory`) and its source, a derived fact with the facts and the rule it rests on (`Paris is located in Europe, because ... and ..., by the rule "located in transitive".`). Relation phrases come from the English lexemes of the lexicon (a lexeme written as a participle or in the third person is recognised), labels from the entity labels, and `local_<name>` symbols (below) are shown as the user wrote the name. An incomplete search adds `The search was not exhaustive, so more answers may exist.`. A clarification is already a question with its options. Every other packet (plans, patterns, constraints, `every`, `explain`) keeps the generic controlled lines. The packet and the trace carry the `retrieval` report and the StrategyRouter `route` of the reasoning step (`chatSop.retrieval`, `chatSop.route`, `chatSop.reasoning_strategy`), shown in the chat's trace panel.
For a unary relation without a reviewed English verb/copula lexeme, the justification uses “The … relation holds for …” (or “does not hold”), rather than inventing a verb from a noun. An existential result backed only by a declaration, including fresh closedness, still renders its used origin label.

## Answer language

The answer is rendered in English from the result packet, which stays the source of truth. When the message is not English, the answer formulation step (DS009 "Answer language") phrases that English answer in the message's language through Ploinky Workers, strictly from the answer and the packet, keeping every number and source id; otherwise the English answer is shown. The English rendering is always kept in the trace.

## Boundary rule and borderline cases

> `stated` only when the model is sure the claim comes from the user's message. Anything the author adds, infers, completes or presupposes is `assumed`. When in doubt, `assumed`.

| Utterance | Formalization |
| --- | --- |
| "Since Nera left the lab, who runs it now?" | `stated` (relation "leave", subject "Nera", object "the lab", asserted) + `query` with `because $s1`: an assertion embedded in a question is still asserted, and the causal "since" is a link. |
| "The rollback failed because the migration is not idempotent." | `@s1 stated` ("fail", "the rollback") with `because $s2`; `@s2 stated` ("be idempotent", "the migration", `polarity negated`). |
| "If Ana works at Acme, does she have access to the lab?" | `@s1 stated` ("work at", `certainty supposed`) + `query` with `if $s1`. |
| "I am asking because Wojciech grows lavender." | a plain `stated` ("grow"); no link: the connective explains the asking. |
| "Is the flumbix of Ana paid?" | the understood part as a query with a placeholder, and `unparsed` with the span "flumbix", `near $q`, `hint subject`. |
| "Ana is a parent of Maria. Is Ana a parent of Maria?" | `stated` + `query`; the result is not hypothetical. |
| "Is Ana *still* at Acme?" | `assumed` (Ana works at Acme, `basis implicature`, no validity: the message names no time) + `query`. |
| "Did Ana visit Cluj *again*?" | `assumed` (Ana visited Cluj, `basis implicature`) + `query`. |
| "Who made The Salt Road?" | `assumed` (`relation "mean"`, `"made"` → `"wrote"`, `basis disambiguation`) + `query` with `relation "make"`; the runtime asks when "make" is ambiguous in its lexicon. |
| "Ana manages Irina. Does she live in Cluj?" | `stated` + `assumed` (`relation "refer to"`, `"she"` → `"Ana"`, `basis disambiguation`) + `query` about Ana. |
| "Ana works at Acme and Irina works at Zeta. Does she live in Cluj?" | `unclear kind ambiguous` with the readings "she is Ana" and "she is Irina". |
| "Is everyone at Acme certified?" / "Is nobody at Acme certified?" | `mode every` with a `scope`, affirmed or negated. |
| "Why is the billing service down?" | `mode explain`. |
| "Aurelia quit because of Shirin." / "Ana got sick from the oysters." | the cause is a role of the causal relation: `role topic "Shirin"` for "because of", `role source "the oysters"` for "from"; a "because" clause that is a whole proposition is its own wire, linked with `because $id`. |
| "Room A and room B are booked. Is room C free?" | two `stated` + `assumed` (room C not booked, `basis closure`) + `query`. |
| "Dorin finished before Avela." | `stated` + optionally `assumed` (the reversed relation negated, `basis world`). |
| "Suppose Maria works at Acme. Would she work at Acme?" | `stated certainty supposed` + `query`. |
| "I think the door is open. Are the rooms connected?" | `stated certainty hedged` + `query`. |
| "Ion says that Maria left." | `stated speaker "Ion"`: attributed, conditional. |
| "Is the bank open?" (two banks known to the runtime) | `query` with `"the bank"`; the runtime finds two entities and asks. The author never chooses. |
| "Tweety is a bird. Can Tweety fly?" | `stated` + optional `assumed` (`basis default`) + `query`; the default is ignored unless the runtime branches. |
| "asdf qwer" | `unclear kind gibberish`, alone. |
| "Thanks!" / "Write a poem." | `unclear kind no_request`, alone. |
| "The square circle is red. Is it red?" | formalized as written (`stated` + `query`); the author does not judge sense. |


## Examples

Valid:

```sop
@s1 stated
  relation "works at"
  role subject "Maria"
  role object "Acme"
  polarity affirmed
  certainty asserted
@q query
  where match
    relation "work at"
    role subject ?who
    role object "Acme"
    polarity affirmed
  end
  select ?who
```

```sop
@a1 assumed
  relation "be booked"
  role subject "room C"
  polarity negated
  basis closure
```

```sop
@u unclear
  kind no_request
```


A chained question ("Who coaches CS Craiova? And where does he work?"):

```sop
@q query
  select ?p
  where match
    relation "coach"
    role subject ?p
    role object "CS Craiova"
    polarity affirmed
  end
@q2 query
  select ?c
  where match
    relation "work at"
    role subject $q
    role object ?c
    polarity affirmed
  end
```

A partially understood message ("Does Ana still work at the flumbix near Obor?"):

```sop
@q query
  where match
    relation "work at"
    role subject "Ana"
    role object ?x
    polarity affirmed
  end
@u1 unparsed
  span "the flumbix near Obor"
  near $q
  hint object
@a1 assumed
  relation "work at"
  role subject "Ana"
  role object ?y
  polarity affirmed
  basis implicature
@u2 unparsed
  span "flumbix"
  near $a1
  hint object
```


Invalid: `holds` on `stated` (parse); a missing `polarity` (parse); `relation works_at` unquoted (parse); `role employee "Maria"` (parse, `role_unknown`); `role subject maria` unquoted (parse); `role subject ?who` in `stated` without an `unparsed` span paired to it (compile, `proposition_not_ground`); `quote "…"` (parse); `valid on "…"` together with `valid from "…"` (parse); `basis world` on `stated` (parse); `certainty hedged` on `assumed` (parse); `basis guess` (parse); `role object $company` naming no wire (graph, `Unknown reference`); `because s2` (parse, `link_form`); `if $s1` naming an asserted clause (compile, `link_condition_not_supposed`); two `$id` role values in one wire (parse, `reference_multiple`); an `unparsed` span that is not in the message (agent guard, `unparsed_span_not_in_message`); an atom `where` leaf in a model query (`query_needs_match`); an `unclear` next to a `query` (`unclear_not_alone`); `kind contradictory` (parse); an `assumed` equal to a statement (`assumed_duplicates_stated`); a `constraint` without `task` (`constraint_task_required`); a `stated` value absent from the message (agent guard, `stated_value_not_in_message`). The wire help pages (`docs/wire_typs/stated.html`, `assumed.html`, `unclear.html`, `query.html`, `unparsed.html`) carry these as executed examples.
