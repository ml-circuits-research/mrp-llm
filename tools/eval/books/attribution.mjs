/** What the system did on one problem, read from the chat turn: understanding, formalization, knowledge, reasoning, rendering. */

/** The "Final answer:" line(s) of a direct reply, else null. */
export function finalLine(text) {
  const t = String(text ?? '').replace(/\*\*/g, '');
  const m = [...t.matchAll(/final answer\s*[:\-]\s*([\s\S]*)$/gi)].at(-1);
  return m ? m[1].replace(/\*\*/g, '').trim() : null;
}

const wireTypes = sop => [...String(sop ?? '').matchAll(/^@\S+\s+(\w+)/gm)].map(m => m[1]);

export function attribution(r) {
  const p = r.packet ?? {}, parse = r.parse ?? {};
  const types = wireTypes(r.sop);
  const proof = p.proof ?? [];
  const kinds = {};
  for (const f of proof) kinds[f.kind ?? 'unknown'] = (kinds[f.kind ?? 'unknown'] ?? 0) + 1;
  const used = (p.used ?? []).map(u => u.id ?? u);
  const q = p.query ?? {};
  return {
    // outcome of the turn
    turn: r.ok ? 'answered_turn' : 'turn_error', error: r.error ?? null,
    status: p.status ?? null, kind: p.kind ?? null, unclear_kind: p.unclear_kind ?? null, complete: p.complete ?? null, reason: p.reason ?? null,
    // understanding: the parse record of the strategy and what the message was read as
    understanding: {strategy: parse.strategy ?? null, questions: parse.steps ?? null, dialog: parse.dialog ?? null, report: parse.report ?? null, parse_ms: parse.ms ?? null, parse_failed: parse.failed ?? null, parse_unclear: parse.unclear ?? null,
      statements_found: (r.userStatements ?? p.user_statements ?? []).length, assumptions: (p.model_assumptions ?? []).length, clause_links: (p.clause_links ?? []).length,
      linked: (p.linking ?? []).length, unresolved_spans: (p.unresolved_spans ?? []).length, repairs: (p.repairs ?? []).length},
    // formalization: the circuit the strategy wrote
    formalization: {sop: r.sop ?? null, wires: types, valid: Boolean(r.sop) && r.ok, mode: q.mode ?? null, where_atoms: (q.where ?? []).length, select: (q.select ?? []).length, filters: (q.filters ?? []).length},
    // knowledge: what the memory held for it
    knowledge: {retrieval_facts: p.retrieval?.facts ?? null, retrieval_rules: p.retrieval?.rules ?? null, retrieval_complete: p.retrieval?.complete ?? null, predicates: (p.retrieval?.predicates ?? []).length, circuits_used: used.length},
    // reasoning: how much the engine did
    reasoning: {engine: p.route?.chosen ?? p.strategy ?? null, backend: p.route?.backend ?? null, route_rule: p.route?.rule ?? null, proof_facts: proof.length, proof_kinds: kinds, rules_used: used.filter(id => !/^c_[0-9a-f]{16,}/.test(id)).length,
      rounds: p.budget?.used?.maxRounds ?? null, joins: p.budget?.used?.maxJoins ?? null, aggregates: (p.sensitivity?.aggregates ?? []).length, answers: (p.answers ?? []).length, count: p.count ?? null, solver_ms: p.timings?.total ?? null},
    // rendering
    rendering: {text_chars: String(r.text ?? '').length, localized: p.localized ?? false},
    answers: (p.answers ?? []).slice(0, 8).map(a => a.binding ?? a),
  };
}
