# conversation-v1: the chat's phrasing and behaviour, as data

Contract: [DS023](../../../docs/specs/DS023-courtesy-and-emotion.md), sections "Conversation layer" and "Behaviour layer"; wire pages
[`reply`](../../../docs/wire_typs/reply.html) and [`instruction`](../../../docs/wire_typs/instruction.html).

Every sentence the chat says is a `reply` wire of this layer. The JS oracle chooses which replies apply to a turn (`lib/conversation/`);
code only turns the result packet into facts and fills `{{slot}}` placeholders. Nothing here is knowledge about the world: the layer is
not imported by the knowledge memories, and every wire id and predicate starts with `cv_`.

## Files

| File | Content |
| --- | --- |
| `0001-vocabulary.sop` | the predicates: the turn facts the runtime writes (`cv_turn_*`), the layer's data and its conclusions |
| `0005-acts.sop` | the message acts the formalizer may name (`cv_act_group`, `cv_act`, `cv_act_description`, `cv_act_example`, `cv_act_standalone`, `cv_act_span`, `cv_act_sets_slot`); the collections declare their own acts in their `0005-acts.sop` |
| `0010-situations.sop` | the rules that derive `cv_applies SITUATION` from the turn facts, and the generic rule `cv_applicable_reply ?r` |
| `0020-data.sop` | `cv_situation_priority` (per part the highest applicable wins) and the pragmatic kinds that select courtesy replies, openings, closings and the short style |
| `0030-replies.sop` | the chat replies (courtesy, unclear messages, near-miss suggestions, openings, closings), several variants per situation |
| `0040-answer-lines.sop`, `0050-host-lines.sop`, `0060-link-questions.sop` | `part line`: the sentences of the answer renderer, the host notices and the KnowledgeLinker questions |
| `0070-behaviour.sop` | the behaviour layer: instruction outcomes, drives (`cv_drive`, `cv_drive_cooldown`, occasions), reaction kinds, greeting-again rules and their replies |
| `0080-analysis-lines.sop` | the sentences of the analysis report (`lib/analysis/report.mjs`, DS022 "Analysis procedures"): header, counts, findings (`line_finding`, or `line_finding_<rule>` when a rule has its own), evidence quotes, measures (`line_report_<predicate>`, else `line_report_row`), the engine-gap notice |
| `0090-personal.sop` | personalisation and register: the parts of the day, the register rule (`cv_register` from a `formal` or `playful` instruction), the user-name and time-of-day situations, their tie-breaks (`cv_situation_outranks`) and replies |

## The reply wire

```
@cv_courtesy_greeting_1 reply
  situation courtesy_greeting      # the situation it serves (a lowercase symbol)
  part body                        # prefix | opening | body | aside | follow_up | closing | suffix | line
  language en                      # English: the answer-formulation step phrases the user's language
  text "Hello! What would you like to know?"
```

Several wires with the same `situation` and `part` are variants (one is picked at random each turn). A new situation needs a rule
deriving `cv_applies <situation>` (or a `cv_courtesy_situation`, `cv_opening_situation`, `cv_closing_situation` fact) and a
`cv_situation_priority <situation> N` fact; `tests/conversation/conversation-layer.test.mjs` checks that every reachable situation has a reply and
a priority. Slots a reply may use: `answer`, `mention`, `candidate`, `candidate_description`, `relations`, `topics`, `readings`,
`aside_fact`, `instruction`, `instructions`, `user_name`, `time_of_day` (and the slots of each `line_*` situation, see
`sop/answer-text.mjs`). A reply that names a slot the turn cannot fill is not applicable (`cv_r_unfillable` over `cv_reply_slot` and
`cv_turn_slot`): another variant or situation answers, and the turn never fails for a missing slot. Two situations of one part with the
same priority are ordered by `cv_situation_outranks`.

## Turn facts written by the runtime

`cv_turn_status`, `cv_turn_unclear`, `cv_turn_signal`, `cv_turn_language`, `cv_turn_computed`, `cv_turn_answered`, `cv_turn_candidate`,
`cv_turn_candidate_exact`, `cv_turn_candidate_described`, `cv_turn_candidate_relations`, `cv_turn_topics`, `cv_turn_readings`,
`cv_turn_aside_available`, `cv_turn_number`, `cv_turns_since`, `cv_seconds_since`, `cv_turn_instruction_set`,
`cv_turn_instruction_cancelled`, `cv_turn_instructions_cancelled`, `cv_turn_instruction_missing`, `cv_turn_instructions_listed`,
`cv_turn_instructions_none`, `cv_instruction_active`, `cv_turn_slot`, `cv_turn_user_name`, `cv_turn_time_of_day`.

Changes to these files reach a running server after `node tools/refresh-seed-memories.mjs --only conversation-v1 --apply` and a
restart; the server warns when the stored copy differs from these files.
