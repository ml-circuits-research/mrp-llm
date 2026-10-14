/**
 * Prompts of the llm-agent baseline. Two presentations of the same problem:
 *   sop  the knowledge slice and the query circuit as SOP text, with the semantics of the language attached;
 *   nl   the natural-language source text of the case (`source.md`), with the same reasoning conventions in prose.
 * The answer is ONE JSON object in the shape of the result packet (proposal 5.3), described in ANSWER_SHAPE.
 * The prompt never contains the expected answer; the conventions are the engine's documented semantics, not hints about a case.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROMPT_VERSION = 'v5';
export const ANSWER_MARKER = 'ANSWER_JSON:';
export const SYSTEM_PROMPT = 'You are a careful logician and planner. You answer exactly one question about the given knowledge.';

/** How the model replies: `cot` works through the problem in plain text first and ends with the marker and the JSON; `direct` replies with the JSON alone. */
const replyRule = reasoning => reasoning === 'direct'
  ? 'Output the JSON object only: no prose, no code fence, no comments.'
  : `Start your reply by working through the problem step by step in plain text. Do NOT begin with JSON. First work through the problem step by step in plain text: list the facts and rules that matter, apply them, check every negation, count and arithmetic step, and check the conventions above. Then end your reply with the line ${ANSWER_MARKER} followed by the JSON object and nothing after it.`;

const here = path.dirname(fileURLToPath(import.meta.url));
const GUIDE = path.resolve(here, '../../../skills/sop-wire-authoring/authoring-guide.md');

/** Sections 1 to 3 of the authoring guide (format, grammar, patterns with examples): the language semantics for a reader. */
export function guideText() {
  try {
    const t = fs.readFileSync(GUIDE, 'utf8');
    const a = t.indexOf('## 1. Format'), b = t.indexOf('## 4.');
    return a >= 0 ? t.slice(a, b > a ? b : undefined) : '';
  } catch { return ''; }
}

const CONVENTIONS = `Reasoning conventions (the engine's documented semantics; follow them exactly):
- Evidence is four-valued per fact: supported (only positive evidence), refuted (only explicit negative evidence, or the fact is absent from a predicate declared closed over a complete list), both (positive and negative evidence together; nothing else breaks), unknown (no evidence either way). Absence of evidence is unknown, never false, unless the list is stated to be complete (closed).
- "absent p a" (negation as failure) is allowed only over a closed (complete) list; "not p a" is explicit negative evidence.
- A count or a sum over a relation that is not stated to be complete is a LOWER BOUND: report the number of known answers with bound "at_least". Over a complete (closed) relation the count is exact and has no bound field.
- A universal question (mode every) over a domain that is not complete and without a counterexample is "unknown" with reason "open_domain"; a counterexample refutes it. Over a closed domain with no counterexample it is supported.
- A count counts DISTINCT bindings (duplicates collapse). Integers only; division rounds toward zero as integers do.
- Defaults ("normally", "usually"): a default concludes its head unless an exception applies, a strict (explicit) contrary fact refutes it, or a default of higher priority concludes the contrary. Two defaults of equal strength with contrary heads give status both. An overriding default blocks the other by firing, not by merely applying.
- Reported, hedged or supposed facts are assumptions: if the answer depends on any of them it is conditional, and you list them. Rules are laws; they have no exceptions.
- Time: a fact with a validity interval holds from its start (inclusive) to its end (exclusive). A derived fact holds only while all its premises hold at the same instant. "throughout/during S E" means at every instant of the period; "overlaps" at some instant; "asof D" means as known on date D (use the versions of rules and procedures approved and in force on D).
- Planning: a plan is the cheapest sequence of actions that achieves the goal, respecting all requirements, hard norms (forbid, oblige hard) and strict methods; soft obligations that cannot be met cost their stated penalty. A choice inside a method is optimised; outside it a strict method allows no other actions. If no legal plan exists but one would exist if named norms or unmet requirements were waived, the status is blocked and blocked_by names them (for an unmet requirement blocked_by is empty and blocked gives the step and the requirement); if none exists even then, no_plan.
- Budget: if the question carries a policy limit (for example maxRounds N: N rounds of forward chaining, each round applying every rule once to the facts known at its start) and the answer needs more work than the limit allows, answer status "budget_exhausted" with complete false and give only rows you have established; never present a cut-off answer as complete and never answer "unknown", "refuted" or "no_plan" because of a cut-off.
- If a question cannot be answered from the knowledge, say unknown. Never use outside knowledge. Do not guess.`;

const ANSWER_SHAPE = `Answer shape (one JSON object; include a field only when it applies to the question's mode, omit all others):
{
  "status": one of "supported" "refuted" "both" "unknown" (select/exists/count/every/explain), "entailed" "possible" "impossible" "inconsistent" "optimal" (constraint tasks prove/possible/optimize), "hypotheses" (abduce), "plan_found" "blocked" "no_plan" (mode plan: the status of a found cheapest plan is plan_found, never optimal), "compliant" "non_compliant" (conform), "procedure_found" (procedure), "budget_exhausted",
  "complete": true, or false only for budget_exhausted,
  "rows": [ {"<variable without ?>": "<symbol or integer as written>"}, ... ]   // select: one object per distinct answer
  "count": integer, "bound": "at_least" (only for a lower bound), "reason": short code such as "open_domain" or the budget limit,
  "witness": {"x": 6, "y": 4}, "counterexample": {"x": 1}, "objective": integer     // constraints: assignments for selected variables
  "explain": {"depth": 0 for a stored fact, 1 when one rule is applied directly to stored facts, 2 when a rule uses a conclusion of such a rule, and so on, "uses": ["parent ann bob", ...]}   // base facts used, as atom text
  "hypotheses": [["rained grass"], ["waive some_norm_id"]]   // abduce: every inclusion-minimal explanation, atoms as text
  "missing": [["parent bob cy"]], "blockers": ["suspended ann", "not escort_authorized cy vault"]   // why_not: minimal atoms to add, and the atoms that block
  "plan": {"cost": integer = total action cost, "steps": number of actions, "names": ["action1", "action2"] = the action ids in order, without arguments}, "relaxed": [norm ids], "obligations_triggered": ["log_all i1"]
  "blocked_by": [norm ids], "blocked": {"step": "~act arg", "requirement": "pred arg"}, "contested": [ids]
  "compliance": {"hard": "ok" or "violated", "violated": [norm ids], "soft_violations": [{"id": "norm", "cost": n}], "deviations": [ids], "total_cost": integer}
  "procedure": {"id": "method id", "version": n, "steps": ["~act ?r", "choose", "~act2 ?r", "end"]}
  "conditional": [ids of a smallest set S of the supposed, hedged or reported facts (and supposed proposed wires) such that the answer still holds when only the observed facts plus S are kept]   // omit when the answer holds on the observed facts alone
  "used": [{"id": "wire id", "version": 1}]   // one sufficient set of the facts, rules, defaults, actions, methods and norms that together give the answer
  "explanation": "one or two sentences"
}
`;

const NL_SHAPE = ANSWER_SHAPE
  .replace(/  "conditional": .*\n/, '  "conditional": true when the answer holds only if a reported, hedged or supposed claim is true, otherwise omit\n')
  .replace(/  "used": .*\n/, '')
  .replace('"relaxed": [norm ids]', '"relaxed": [names of norms]')
  .replace(/\[norm ids\]/g, '[names of the norms or rules]')
  .replace('[ids]', '[names]');

/** The SOP presentation: knowledge circuit, query circuit and the language semantics. */
export function sopPrompt({knowledge, query, reasoning = 'cot'}) {
  const guide = guideText();
  return `You are given a body of knowledge written as SOP wires and ONE query wire. Answer the query from the knowledge only.

${CONVENTIONS}

How to read SOP wires (language guide):
${guide}

${ANSWER_SHAPE}

KNOWLEDGE:
${knowledge.trim()}

QUERY:
${query.trim()}

${replyRule(reasoning)}`;
}

/** The natural-language presentation: the source text, which states the situation and the question. */
export function nlPrompt({source, reasoning = 'cot'}) {
  return `Read the text below. It describes a situation and ends with ONE question. Answer the question from the text only.

${CONVENTIONS.replace(/- "absent p a"[^\n]*\n/, '')}

${NL_SHAPE}

Write every entity, action and predicate name as a lowercase symbol with words joined by underscores ("Alpha Lab" becomes alpha_lab, "deploy blue-green" becomes deploy_blue_green); never use capitals or spaces inside a name.

TEXT:
${source.trim()}

${replyRule(reasoning)}`;
}
