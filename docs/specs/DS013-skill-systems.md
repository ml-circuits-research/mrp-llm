---
title: DS013-skill-systems
summary: Evidence-gated failure classification, inert scoped micro-theory proposals, and authorized implicit SOP registry decisions.
---

# Skill systems

These three importable JavaScript components are diagnostic and review-side tools. They use the existing SOP parser and are exercised against actual `Runtime.run` and `ReasoningRegistry` calls by `node --test tests/reasoning/skill-systems.test.mjs`. No training, fine-tuning, optimizer or neural inference occurs. None is connected to automatic publication, the production runtime library or the trusted `remember` write path. Supplied review and authorization metadata are claims of the caller until the host independently verifies them.

## Failure classifier

`classifyFailure({question, goldSop, candidateSop, goldExecution, candidateExecution, diagnostics})` in `skills/failure-classifier/classify.mjs` parses both SOP circuits with `sop/parser.mjs` and requires actual-shaped execution packets (`{result:{status,complete}}`); callers must provide the **actual** outputs of the specified executions and independently establish the diagnostic facts below. The result is `{classification, component, evidence}`. Evidence records observed statuses and attribution. The classifier does not execute either circuit or authenticate a source review, input digest or reviewer's identity.

| Classification | Required diagnostic evidence | Repair owner |
| --- | --- | --- |
| `source_gap` | Both completed circuits are identical and unknown; reviewed source ID, exact quote, reviewer and normalized source assertion, absent as a fact/rule condition from both circuits | Source acquisition / reviewed knowledge ingestion |
| `semantic_gap` | Completed gold and candidate circuits differ, same host input digest, distinct outcomes and gold supported/refuted; no attested unsupported extra candidate statement | SOP formalization / reviewed semantic mapping |
| `reasoning_gap` | Identical parsed circuits and attested identical host input digest, but different complete execution outcomes | Reasoning backend / execution |
| `ambiguity` | At least two source-quoted, reviewer-attributed competing SOP interpretations of the question have distinct observed completed outcomes | Question clarification |
| `over_inference` | Gold unknown and candidate supported on the same attested input; the candidate contains an extra statement independently reviewed as unsupported by the cited source | Unsupported statement / candidate SOP authoring |

A missing/incomplete result, ungrounded difference or competing diagnostic signals yields `insufficient_evidence` and no repair component. Different outputs alone do not prove an error's cause. The attested source quote, scope review and same-input digest must be established by the caller; this module has no independent NL truth oracle. The reasoner-gap regression intentionally runs an adapter that drops a supplied fact; both contrasting outputs are produced by real runtime calls, not invented packets.

## Semantic gap resolver

`proposeMicroTheories({gap:{question,evidenceId},candidates})` in `skills/semantic-gap-resolver/resolve.mjs` requires caller-supplied hypotheses with `{scope:{domain,population,validity},status,conditions,conclusion,exceptions,provenance:{sourceId,quote,reviewer}}`. `status` is **HARD** (proposed unconditional rule only within reviewed scope, subject to exceptions), **DEFAULT** (defeasible generalization), or **PLAUSIBLE** (hypothesis, not a verified fact). The resolver validates and normalizes whitespace SOP atoms (e.g., `parent mara sorin`), requires an explicit exceptions array, and preserves each exception's `when` atoms and rationale. Its returned `micro-theory-proposal` has `execution:'proposal-only'`; it includes positive, negative, every-exception and scope-boundary validation obligations. An exception such as `access_revoked ?person` is both retained in the proposal and assigned its own probe; it is never discarded to make a rule appear unconditional.

**Non-production boundary:** these objects are review proposals, not `@rule` wires, accepted `@fact` wires, `remember` inputs or automatically executed theories. Generating a validation plan does not run the plan. A human/host must inspect source truth, scope, polarity, counterexamples, provenance and authorization, independently run positive/negative/exception/boundary probes, and decide whether publication is permitted. Finite probes do not prove universal validity. DEFAULT and PLAUSIBLE cannot be promoted into deductive executable rules.

## Implicit SOP registry

`new ImplicitSopRegistry({authorize, state?})` in `skills/implicit-sop-registry/registry.mjs` holds inert proposal versions in memory; `exportState()` and the constructor's `state` parameter allow the **host** to persist and reload a snapshot (the registry itself does not write to memory/repository). `register(proposal)` produces `{id,version,duplicate}`. `revise(id,proposal)` creates a new candidate version for a changed scoped theory; previously accepted versions remain active until replaced or retracted. `get(id)` returns a copy of the version history. `lookup(proposal)` returns a copy of a matching **accepted active proposal only**, never executable SOP and never candidates, rejected versions or retracted versions. Semantic de-duplication normalizes SOP atom syntax, condition order and logical variable names while retaining predicate, terms, polarity, scope, conclusion and exception conditions; it does not purport to decide arbitrary first-order logical equivalence. Provenance and epistemic status are not parts of the semantic fingerprint: a duplicate does not grant it a new permission or overwrite reviewed metadata.

Version states are **candidate**, **accepted**, **rejected** and **retracted**. `decide(id,version,{action:'accept'|'reject',authorization,rationale,validation})` requires explicit host authorization callback approval; the default authorizer rejects everything. To accept, the version must be HARD and host-provided validation receipts must cover positive, negative, boundary and every exception probe. The registry records receipts as supplied and **cannot authenticate them or establish that probes actually ran**: the host is responsible for verifying them before returning `true` from its authorization callback. Rejection is also authorized. Acceptance of a new version retracts a previously accepted version. `retract(id,{authorization,evidence:{sourceId,observation}})` requires new evidence and explicit authorization, clears the active version, and immediately makes subsequent lookups return `null`, including after state export/reload; history retains the retraction and its evidence. An inactive older version is never silently reactivated. Registry acceptance alone **does not publish** into `Repository`, the SOP library, or any user session. Actual production admission remains a separate reviewed host-controlled operation.

### Executable check

```sh
node --test tests/reasoning/skill-systems.test.mjs
```

The scoped test runs actual SOP queries and a deliberately faulty strategy to discriminate all five diagnostic categories, checks that insufficient evidence is refused, verifies the retained exception and its validation obligation, and exercises duplicate detection, changed-version history, unauthorized promotion refusal, missing-exception-validation refusal, authorized acceptance, snapshot reload and evidence-triggered rollback. The tests do not claim a human review occurred or that their example source statements are real-world truths.
