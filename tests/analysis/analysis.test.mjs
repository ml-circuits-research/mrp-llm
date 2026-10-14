// Analysis procedures (DS022 "Analysis procedures"): the starter library analysis-core-v1, the analyzer lib/analysis (document view,
// procedures as members, the StrategyRouter and the oracle's proofs), the report from the conversation layer, every procedure kind on
// small documents, parameters, domain procedures as data, the sources (circuits, a base memory, a session), the HTTP routes, the
// ChatSOPAdapter mode, the task template and the test set eval/analysis-v1 at level (a). No test calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {analyzeSession, listProcedures, wireIndex, analysisProcedures, memberLint} from '../../lib/analysis/index.mjs';
import {ensureAnalysisMemory} from '../../lib/analysis/memory.mjs';
import {seedLayers, seedCircuits} from '../../lib/knowledge-seeds.mjs';
import {validateProgram} from '../../sop/knowledge/index.mjs';
import {setReplyLayer, shippedCircuits} from '../../sop/replies.mjs';
import {solverAvailable} from '../../reasoning/registry.mjs';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {Sessions} from '../../lib/chat-data/sessions.mjs';
import {checkAnalyzeBody} from '../../server/analysis.mjs';
import {repoPath, tempDir} from '../helpers.mjs';

const LIBRARY = seedLayers('analysis-core-v1');
const doc = (text, name = 'doc') => ({name: `${name}.sop`, text, provenance: {kind: 'document', document: `${name}.md`}});
const run = (text, procedures = null, options = {}, extra = []) => analyzeSession({circuits: [...LIBRARY, doc(text), ...extra]}, procedures, options);
const fired = r => r.findings.map(f => `${f.rule.id} ${f.witness}`).sort();
const measure = (r, atomStart) => r.measures.find(m => m.atom.startsWith(atomStart));
const fact = (id, holds, quote = null, line = 1) => `@${id} fact\n  holds ${holds}\n${quote ? `  quote ${JSON.stringify(quote)}\n` : ''}  source "doc.md, line ${line}"\n`;

test('analysis-core-v1 validates with core-min, every procedure is tagged, described and complete in its members', () => {
  const files = [...seedCircuits('core-min'), ...seedCircuits('analysis-core-v1')].map(c => ({name: c.file, text: c.text, role: 'knowledge'}));
  const v = validateProgram(files, {authoring: true});
  assert.deepEqual(v.problems.filter(p => p.severity !== 'warning').map(p => `${p.code} ${p.wire} ${p.message}`), []);
  const index = wireIndex(LIBRARY);
  const procs = analysisProcedures(index);
  assert.deepEqual(procs.map(p => p.id).sort(), ['analysis_claim_support', 'analysis_contradictions', 'analysis_kpis', 'analysis_numeric_consistency', 'analysis_quality_rubric', 'analysis_temporal_consistency']);
  for (const p of procs) {
    assert.ok(p.description.startsWith('Analysis: '), p.id);
    assert.ok(p.integrity.length || p.reports.length, `${p.id} reports something`);
    assert.deepEqual(p.missing, [], `${p.id} names only existing wires`);
  }
  assert.deepEqual(memberLint(procs, index), [], 'every member can fire with the members alone');
  assert.deepEqual(procs.find(p => p.id === 'analysis_numeric_consistency').parameters.map(x => x.name).sort(), ['share_tolerance', 'total_tolerance']);
});

test('the report field of a procedure (proposal P-8) is checked: an atom pattern, arity against the declaration', () => {
  const base = '@kpi_x predicate\n  args subject:entity object:value\n@r1 rule\n  when amount ?q ?v\n  then kpi_x ?q ?v\n';
  const ok = validateProgram([{name: 'p.sop', role: 'knowledge', text: `${base}@amount predicate\n  args subject:entity object:value\n@p procedure\n  members $r1\n  report kpi_x ?q ?v\n`}], {authoring: true});
  assert.deepEqual(ok.problems.filter(p => p.severity !== 'warning'), []);
  const bad = validateProgram([{name: 'p.sop', role: 'knowledge', text: `${base}@amount predicate\n  args subject:entity object:value\n@p procedure\n  members $r1\n  report not kpi_x ?q\n`}], {authoring: true});
  assert.ok(bad.problems.some(p => p.code === 'bad_atom'), 'a negated report atom is refused');
  const arity = validateProgram([{name: 'p.sop', role: 'knowledge', text: `${base}@amount predicate\n  args subject:entity object:value\n@p procedure\n  members $r1\n  report kpi_x ?q\n`}], {authoring: true});
  assert.ok(arity.problems.some(p => p.code === 'arity_mismatch'), JSON.stringify(arity.problems));
});

test('contradictions: asserted and denied (directly and through the document rules), two values of a key, disjoint classes', () => {
  const text = ['@flies predicate\n  args subject:entity\n@bird predicate\n  args subject:entity\n',
    fact('d1', 'not flies tweety', 'Tweety cannot fly.', 3), fact('d2', 'bird tweety', 'Tweety is a bird.', 4),
    '@d3 rule\n  when bird ?x\n  then flies ?x\n  quote "Birds fly."\n  source "doc.md, line 5"\n',
    fact('d4', 'amount box_weight 4', 'The box weighs 4 kg.', 6), fact('d5', 'amount box_weight 5', 'The box weighs 5 kg.', 9),
    fact('d6', 'is_a acme organization', 'Acme is a company.', 10), fact('d7', 'is_a acme person', 'Acme is a person.', 11)].join('\n');
  const r = run(text, ['analysis_contradictions']);
  assert.deepEqual(fired(r), ['an_conflicting_values amount box_weight', 'an_contradicted_atom flies tweety', 'an_disjoint_membership acme']);
  const c = r.findings.find(f => f.rule.id === 'an_contradicted_atom');
  assert.deepEqual(c.evidence.map(e => e.wire).sort(), ['d1', 'd2', 'd3'], 'the fact, the denial and the rule that derives the other side');
  assert.deepEqual(c.evidence.find(e => e.wire === 'd1'), {...c.evidence.find(e => e.wire === 'd1'), document: 'doc.md', location: 'doc.md, line 3', quote: 'Tweety cannot fly.'});
  assert.equal(c.severity, 'error');
  assert.ok(c.proof.nodes.some(n => n.atom === 'violation an_contradicted_atom "flies tweety"'), 'the oracle proof of the violation');
  assert.ok(c.rules.includes('an_contradicted_atom'), 'the rule that fired');
  assert.deepEqual(c.view.map(v => v.asserted ?? v.denied).sort(), ['flies tweety', 'flies tweety']);
});

test('numeric consistency: totals, breakdowns, shares, units, stated limits and plausible ranges; a consistent document has none', () => {
  const bad = [fact('a1', 'amount total 100'), fact('a2', 'breakdown_complete total'), fact('a3', 'component_of p1 total'), fact('a4', 'amount p1 50'), fact('a5', 'component_of p2 total'), fact('a6', 'amount p2 30'),
    fact('a7', 'unit_of total eur'), fact('a8', 'unit_of p1 eur'), fact('a9', 'unit_of p2 usd'),
    fact('b1', 'share_of s1 market 60'), fact('b2', 'share_of s2 market 50'),
    fact('c1', 'share_of p1 total 40'),
    fact('e1', 'amount pressure 12'), fact('e2', 'upper_limit pressure 10'), fact('e3', 'amount dose 1'), fact('e4', 'lower_limit dose 2'),
    fact('g1', 'amount efficiency 112'), fact('g2', 'measure_of efficiency percentage'), fact('g3', 'amount wall -300'), fact('g4', 'measure_of wall temperature_celsius')].join('\n');
  const r = run(bad, ['analysis_numeric_consistency']);
  assert.deepEqual(fired(r), ['an_above_upper_limit pressure', 'an_below_lower_limit dose', 'an_breakdown_mismatch total', 'an_implausible_high efficiency', 'an_implausible_low wall',
    'an_share_amount_mismatch p1', 'an_shares_exceed_100 market', 'an_unit_mismatch p2']);
  assert.equal(r.findings.find(f => f.rule.id === 'an_unit_mismatch').severity, 'warning');
  const exceed = run([fact('a1', 'amount total 100'), fact('a3', 'component_of p1 total'), fact('a4', 'amount p1 70'), fact('a5', 'component_of p2 total'), fact('a6', 'amount p2 40')].join('\n'), ['analysis_numeric_consistency']);
  assert.deepEqual(fired(exceed), ['an_parts_exceed_total total'], 'parts above their total, with or without a complete breakdown');
  const shares = run([fact('s0', 'breakdown_complete m'), fact('s1', 'share_of a m 40'), fact('s2', 'share_of b m 50')].join('\n'), ['analysis_numeric_consistency']);
  assert.deepEqual(fired(shares), ['an_shares_below_100 m']);
  const partial = run([fact('s0', 'breakdown_complete m'), fact('s3', 'component_of a m'), fact('s4', 'component_of b m'), fact('s1', 'share_of a m 40')].join('\n'), ['analysis_numeric_consistency']);
  assert.deepEqual(fired(partial), [], 'a share stated for one component only is not a breakdown into shares');
  const good = run([fact('a1', 'amount total 100'), fact('a2', 'breakdown_complete total'), fact('a3', 'component_of p1 total'), fact('a4', 'amount p1 60'), fact('a5', 'component_of p2 total'), fact('a6', 'amount p2 40'),
    fact('b1', 'share_of p1 total 60'), fact('b2', 'share_of p2 total 40'), fact('e1', 'amount pressure 9'), fact('e2', 'upper_limit pressure 10')].join('\n'));
  assert.deepEqual(fired(good), [], 'no false finding on a consistent document');
});

test('temporal consistency: an end before its start, an order against the dates, ages', () => {
  const text = [fact('t1', 'starts_on project 20260301'), fact('t2', 'ends_on project 20260201'), fact('t3', 'precedes design build'), fact('t4', 'starts_on design 20260501'), fact('t5', 'starts_on build 20260401'),
    fact('t6', 'as_of_year 2025'), fact('t7', 'born_in_year ana 1990'), fact('t8', 'age_years ana 40'), fact('t9', 'born_in_year bob 1980'), fact('t10', 'age_years bob 44'),
    fact('t11', 'age_years old_tom 150'), fact('t12', 'born_in_year baby 2030')].join('\n');
  const r = run(text, ['analysis_temporal_consistency']);
  assert.deepEqual(fired(r), ['an_age_mismatch ana', 'an_born_after_reference baby', 'an_end_before_start project', 'an_impossible_age old_tom', 'an_order_against_dates design']);
  assert.ok(!fired(r).some(f => f.includes(' bob')), 'an age within the tolerance (a birthday later in the year) is not a finding');
});

test('claims without support: a premise the document never states; a stated premise supports', () => {
  const r = run([fact('c1', 'claim_rests_on growth order_book'), fact('c2', 'claim_rests_on safety test_report'), fact('c3', 'premise_stated test_report')].join('\n'), ['analysis_claim_support']);
  assert.deepEqual(fired(r), ['an_unsupported_claim growth']);
  assert.equal(r.findings[0].severity, 'warning');
});

test('KPIs: shares, growth, averages and ratios defined as data; no value for a zero denominator or mixed units', () => {
  const text = [fact('k1', 'amount rev 200'), fact('k2', 'component_of eu rev'), fact('k3', 'amount eu 150'), fact('k4', 'component_of us rev'), fact('k5', 'amount us 50'),
    fact('k6', 'period_amount rev y2025 200'), fact('k7', 'period_amount rev y2024 160'), fact('k8', 'period_follows y2025 y2024'),
    fact('k9', 'amount profit 30'), fact('k10', 'amount zero_base 0'),
    fact('m1', 'amount mass 2'), fact('m2', 'unit_of mass kg'), fact('m3', 'component_of core mass'), fact('m4', 'amount core 1500'), fact('m5', 'unit_of core g')].join('\n');
  const request = {name: 'request.sop', text: '@q_margin fact\n  holds ratio_definition margin profit rev\n@q_bad fact\n  holds ratio_definition bad profit zero_base\n@my_ratios procedure\n  members $an_k_ratio $q_margin $q_bad\n  description "Analysis: the margin the analyst asks for."\n  scope "analysis, kpis"\n  report kpi_ratio ?name ?ratio\n'};
  const r = run(text, ['analysis_kpis', 'my_ratios'], {}, [request]);
  const value = a => Object.values(measure(r, a)?.values ?? {}).at(-1);
  assert.equal(value('kpi_share eu rev'), 75);
  assert.equal(value('kpi_share us rev'), 25);
  assert.equal(value('kpi_growth rev y2025'), 25);
  assert.equal(value('kpi_average rev'), 100);
  assert.equal(value('kpi_ratio margin'), 0.15);
  assert.equal(measure(r, 'kpi_ratio bad'), undefined, 'a zero denominator gives no value');
  assert.equal(measure(r, 'kpi_share core mass'), undefined, 'a part in another unit than its whole gets no share');
  assert.equal(measure(r, 'kpi_average mass'), undefined);
  const share = measure(r, 'kpi_share eu rev');
  assert.deepEqual(share.evidence.map(e => e.wire).sort(), ['k1', 'k2', 'k3'], 'the KPI is reported with the document wires it is computed from');
  assert.ok(share.rules.includes('an_k_share') && share.proof.nodes.length > 1);
  assert.deepEqual(measure(r, 'kpi_ratio margin').procedures, ['analysis_kpis', 'my_ratios'], 'one row, reported once, with every procedure that asks for it');
});

test('the quality rubric: the score is the weight of the criteria met, with the criteria behind it', () => {
  const r = run([fact('q1', 'as_of_year 2026'), fact('q2', 'amount cost 5'), fact('q3', 'claim_rests_on x y')].join('\n'), ['analysis_quality_rubric']);
  const values = pred => r.measures.filter(m => m.predicate === pred).map(m => Object.values(m.values).at(-1)).sort();
  assert.deepEqual(values('rubric_score'), [7]);
  assert.deepEqual(values('rubric_max'), [11]);
  assert.deepEqual(values('criterion_failed'), ['claims_supported', 'units_stated']);
  assert.deepEqual(values('criterion_met'), ['consistent', 'dates_consistent', 'reference_year_stated', 'totals_add_up']);
  assert.deepEqual(r.findings, [], 'a rubric reports measures, not findings');
});

test('parameters are member facts; a run overrides them by name; an unknown parameter is refused', () => {
  const text = [fact('a1', 'amount total 100'), fact('a2', 'breakdown_complete total'), fact('a3', 'component_of p1 total'), fact('a4', 'amount p1 99.5')].join('\n');
  assert.deepEqual(fired(run(text, ['analysis_numeric_consistency'])), ['an_breakdown_mismatch total']);
  const loose = run(text, ['analysis_numeric_consistency'], {parameters: {total_tolerance: 1}});
  assert.deepEqual(fired(loose), [], 'a tolerance of 1 accepts a difference of 0.5');
  assert.deepEqual(loose.procedures[0].parameters.find(p => p.name === 'total_tolerance'), {name: 'total_tolerance', value: 1, overridden: true});
  assert.throws(() => run(text, ['analysis_numeric_consistency'], {parameters: {no_such: 1}}), e => e.code === 'unknown_parameter');
  assert.throws(() => run(text, ['analysis_numeric_consistency'], {parameters: {total_tolerance: 'x'}}), e => e.code === 'invalid_parameter');
});

test('a domain procedure is data: its own integrity constraint, rule and report line over the document wires', () => {
  const domain = {name: 'hr.sop', text: '@leave_days predicate\n  args subject:entity object:value\n@hr_min_leave integrity\n  never all\n    leave_days ?c ?d\n    compare ?d below 20\n  end\n  witness ?c\n  message "the legal minimum is 20 days of leave"\n  severity error\n@hr_policy procedure\n  members $hr_min_leave\n  description "Analysis: the HR rules of the domain."\n  scope "analysis, findings"\n'};
  const text = '@d1 fact\n  holds leave_days interns 15\n  quote "Interns get 15 days."\n  source "doc.md, line 2"\n';
  const r = analyzeSession({circuits: [...LIBRARY, domain, doc(text)]}, ['hr_policy']);
  assert.deepEqual(fired(r), ['hr_min_leave interns']);
  assert.match(r.text, /the legal minimum is 20 days of leave/);
  assert.ok(listProcedures({circuits: [...LIBRARY, domain, doc(text)]}).procedures.some(p => p.id === 'hr_policy'));
});

test('the report text comes from the conversation layer; a rule may have its own line_finding_<id>', t => {
  const text = [fact('d1', 'amount w 4', 'It weighs 4 kg.', 2), fact('d2', 'amount w 5', 'It weighs 5 kg.', 7)].join('\n');
  const r = run(text, ['analysis_contradictions']);
  assert.match(r.text, /^Analysis of doc\.md with analysis_contradictions\./);
  assert.match(r.text, /Error: the document gives two different values for the same thing \(amount w; rule an_conflicting_values of analysis_contradictions\)\./);
  assert.match(r.text, /doc\.md, line 2: "It weighs 4 kg\."/);
  t.after(() => setReplyLayer(shippedCircuits(), 'shipped'));
  setReplyLayer([...shippedCircuits(), {name: 'own.sop', text: '@own reply\n  situation line_finding_an_conflicting_values\n  part line\n  language en\n  text "Two values for {{witness}}."\n'}], 'test');
  assert.match(run(text, ['analysis_contradictions']).text, /^Two values for amount w\.$/m);
  setReplyLayer(shippedCircuits().filter(c => !c.name.includes('analysis')), 'a stored copy older than the analysis lines');
  const stale = run(text, ['analysis_contradictions']);
  assert.equal(stale.text, null);
  assert.equal(stale.render_error.code, 'reply_missing');
  assert.equal(stale.findings.length, 1, 'the analysis stands without its text');
});

test('errors: no document layer, unknown procedure, a document id that clashes with a member', () => {
  assert.throws(() => analyzeSession({circuits: LIBRARY}), e => e.code === 'no_document_layer');
  assert.throws(() => run(fact('d1', 'amount x 1'), ['no_such_procedure']), e => e.code === 'unknown_procedure');
  assert.throws(() => run(fact('an_p_total_tolerance', 'amount x 1'), ['analysis_numeric_consistency']), e => e.code === 'id_collision');
  assert.throws(() => analyzeSession({circuits: [doc(fact('d1', 'amount x 1'))]}), e => e.code === 'no_procedures');
});

test('engines: an explicit engine runs exactly, its gaps are reported, never replaced; prolog-tabling agrees with the oracle', {timeout: 300000}, () => {
  const text = [fact('a1', 'amount total 100'), fact('a2', 'breakdown_complete total'), fact('a3', 'component_of p1 total'), fact('a4', 'amount p1 60'), fact('a5', 'not ok x'), fact('a6', 'ok x'),
    '@ok predicate\n  args subject:entity\n'].join('\n');
  const auto = run(text, ['analysis_contradictions', 'analysis_numeric_consistency']);
  assert.deepEqual(auto.routes.engines, ['js-reference'], 'a small document stays on the oracle (StrategyRouter R2)');
  const missing = run(text, ['analysis_contradictions'], {reasoning: 'no-such-engine'});
  assert.equal(missing.findings.length, 0);
  assert.ok(missing.routes.unsupported.length > 0 && /could not run on the requested engine no-such-engine/.test(missing.text));
  if (!solverAvailable('prolog')) return;
  const prolog = run(text, ['analysis_contradictions', 'analysis_numeric_consistency'], {reasoning: 'prolog-tabling'});
  assert.deepEqual(prolog.routes.engines, ['prolog-tabling']);
  assert.deepEqual(fired(prolog), fired(auto));
});

test('sources: a base memory and a session with document provenance, documents selected by name', t => {
  const root = tempDir(t, 'chatsop-analysis-');
  const chatData = ChatData.open({chatData: {root: path.join(root, 'chat_data')}}, {});
  const memories = new BaseMemories({chatData});
  assert.deepEqual(ensureAnalysisMemory(memories).created, ['core-min', 'analysis-core-v1']);
  assert.deepEqual(ensureAnalysisMemory(memories).created, [], 'idempotent');
  memories.create({id: 'reports', name: 'Reports', imports: ['analysis-core-v1']});
  const text = [fact('r1', 'amount w 4', 'It weighs 4 kg.', 2), fact('r2', 'amount w 5', 'It weighs 5 kg.', 7)].join('\n');
  memories.addKnowledge('reports', {circuits: [{name: 'report-a', text}], approvedBy: 'test', reason: 'test', source: {kind: 'document', document: 'a.md', lines: [1, 9]}});
  memories.addKnowledge('reports', {circuits: [{name: 'notes', text: fact('n1', 'amount z 1')}], approvedBy: 'test', reason: 'test', source: {kind: 'manual'}});
  const m = analyzeSession({memories, id: 'reports'}, ['analysis_contradictions']);
  assert.deepEqual(m.documents.map(d => d.document), ['a.md'], 'only the circuits with document provenance are the document layer');
  assert.deepEqual(fired(m), ['an_conflicting_values amount w']);
  const sessions = new Sessions({chatData, memories});
  const s = sessions.create({base: 'analysis-core-v1', user: 'u'});
  sessions.addCircuit(s.id, {name: 'doc-b', text: [fact('b1', 'amount v 1', 'One.', 1), fact('b2', 'amount v 2', 'Two.', 2)].join('\n'), request: {kind: 'document', document: 'b.md'}, origin: 'document_ingestion'});
  sessions.addCircuit(s.id, {name: 'doc-c', text: fact('c1', 'not ok y', 'Not ok.', 1), request: {kind: 'document', document: 'c.md'}, origin: 'document_ingestion'});
  const both = analyzeSession({sessions, id: s.id}, ['analysis_contradictions']);
  assert.deepEqual(both.documents.map(d => d.document).sort(), ['b.md', 'c.md']);
  const onlyB = analyzeSession({sessions, id: s.id}, ['analysis_contradictions'], {documents: ['b.md']});
  assert.deepEqual(onlyB.documents.map(d => d.document), ['b.md']);
  assert.deepEqual(fired(onlyB), ['an_conflicting_values amount v']);
  assert.throws(() => analyzeSession({sessions, id: s.id}, null, {documents: ['nope.md']}), e => e.code === 'unknown_document');
});

test('the HTTP routes: analyze a session and a base memory, list procedures, refuse bad bodies', async t => {
  assert.throws(() => checkAnalyzeBody({procedure: ['x']}), e => e.code === 'unsupported_parameter');
  assert.throws(() => checkAnalyzeBody({verify: 'maybe'}), e => e.code === 'invalid_parameter');
  assert.deepEqual(checkAnalyzeBody({}), {procedures: null, documents: null, parameters: {}, reasoning: 'auto', verify: 'auto', proofs: true});
  const {productServer} = await import('../product-helpers.mjs');
  const s = await productServer(t);
  const created = await s.user('/v1/sessions', 'POST', {base: 'analysis-core-v1'});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sid = created.body.id;
  const listed = await s.user(`/v1/sessions/${sid}/analysis-procedures`);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.some(p => p.id === 'analysis_kpis'));
  const none = await s.user(`/v1/sessions/${sid}/analyze`, 'POST', {});
  assert.equal(none.status, 422);
  assert.equal(none.body.error.code, 'no_document_layer');
  const procs = await s.user('/v1/memories/analysis-core-v1/analysis-procedures');
  assert.equal(procs.status, 200);
  assert.equal(procs.body.data.length, 6);
  const text = [fact('d1', 'amount w 4', 'It weighs 4 kg.', 2), fact('d2', 'amount w 5', 'It weighs 5 kg.', 7), fact('d3', 'amount p 12'), fact('d4', 'upper_limit p 10')].join('\n');
  const memory = await s.user('/v1/memories', 'POST', {id: 'audit', name: 'Audit', imports: ['analysis-core-v1'], circuits: [{name: 'manual', text}], source: {kind: 'document', document: 'manual.md'}});
  assert.equal(memory.status, 201, JSON.stringify(memory.body));
  const analysed = await s.user('/v1/memories/audit/analyze', 'POST', {procedures: ['analysis_contradictions', 'analysis_numeric_consistency'], proofs: false});
  assert.equal(analysed.status, 200, JSON.stringify(analysed.body));
  assert.deepEqual(fired(analysed.body), ['an_above_upper_limit p', 'an_conflicting_values amount w']);
  assert.ok(analysed.body.findings.every(f => !('proof' in f)), 'proofs: false leaves the proofs out');
  assert.match(analysed.body.text, /manual\.md, doc\.md, line 2: "It weighs 4 kg\."/, "the document of the provenance, then the location the wire names");
  const unknown = await s.user('/v1/memories/audit/analyze', 'POST', {procedures: ['nope']});
  assert.equal(unknown.status, 404);
});

test('the analysis mode of ChatSOPAdapter (when lib/adapter is present)', async t => {
  if (!fs.existsSync(repoPath('lib/adapter/index.mjs'))) return t.skip('lib/adapter is not in this checkout');
  const {registerAnalysisMode} = await import('../../lib/analysis/adapter.mjs');
  assert.equal(await registerAnalysisMode(), 'analysis');
  const {createChatSOPAdapter} = await import('../../lib/adapter/index.mjs');
  const adapter = createChatSOPAdapter({});
  t.after(() => adapter.dispose());
  const text = [fact('d1', 'amount w 4', 'It weighs 4 kg.', 2), fact('d2', 'amount w 5', 'It weighs 5 kg.', 7)].join('\n');
  const p = await adapter.answer({message: 'check the document', mode: 'analysis', options: {analysis: {source: {circuits: [...LIBRARY, doc(text)]}, procedures: ['analysis_contradictions']}}});
  assert.equal(p.mode, 'analysis');
  assert.equal(p.path, 'analysis');
  assert.deepEqual(p.answer.values, ['an_conflicting_values:"amount w"']);
  assert.match(p.answer.text, /two different values/);
  assert.equal(p.proofs.length, 1);
  await assert.rejects(adapter.answer({message: 'x', mode: 'analysis', options: {}}), e => e.code === 'invalid_parameter');
});

test('the task template analyze-document: declared parameters, targets, and an adapter that loads', async () => {
  const tpl = JSON.parse(fs.readFileSync(repoPath('jobs/templates/analyze-document/template.json'), 'utf8'));
  assert.equal(tpl.kind, 'adapter');
  assert.deepEqual(tpl.targets, ['memory', 'session', 'none']);
  assert.ok(tpl.params.rights.enum.includes('owner-provided'));
  const mod = await import('../../jobs/templates/analyze-document/adapter.mjs');
  assert.equal(typeof mod.run, 'function');
});

test('the test set eval/analysis-v1 at level (a): every planted issue found, no spurious finding, every KPI and rubric score right', {timeout: 120000}, () => {
  const set = repoPath('eval/analysis-v1');
  const truth = JSON.parse(fs.readFileSync(path.join(set, 'truth.json'), 'utf8')).documents;
  assert.ok(Object.keys(truth).length >= 6 && Object.keys(truth).length <= 10);
  for (const [name, t] of Object.entries(truth)) {
    const md = fs.readFileSync(path.join(set, 'documents', `${name}.md`), 'utf8').split('\n');
    const read = f => (fs.existsSync(path.join(set, 'sop', f)) ? [{name: f, text: fs.readFileSync(path.join(set, 'sop', f), 'utf8')}] : []);
    const [own] = read(`${name}.sop`);
    // Every quote of the hand-written SOP is words of the document at the line it names.
    for (const m of own.text.matchAll(/quote ("(?:[^"\\]|\\.)*")\n  source "[^"]*, line (\d+)"/g)) assert.ok(md[Number(m[2]) - 1].includes(JSON.parse(m[1])), `${name}: ${m[1]} is on line ${m[2]}`);
    const r = analyzeSession({circuits: [...LIBRARY, {...own, provenance: {kind: 'document', document: `${name}.md`}}, ...read(`${name}.request.sop`)]});
    assert.deepEqual(fired(r), t.findings.map(f => `${f.rule} ${f.witness}`).sort(), name);
    for (const k of t.kpis) {
      const m = r.measures.find(x => x.predicate === k.predicate && JSON.stringify(Object.values(x.values).slice(0, -1)) === JSON.stringify(k.key));
      assert.ok(m && Math.abs(Object.values(m.values).at(-1) - k.value) <= 0.005, `${name}: ${k.predicate} ${k.key.join(' ')} = ${k.value}`);
    }
    assert.equal(Object.values(r.measures.find(x => x.predicate === 'rubric_score')?.values ?? {}).at(-1) ?? 0, t.rubric.score, `${name}: rubric`);
    assert.ok(r.findings.every(f => f.evidence.length && f.evidence.every(e => e.document === `${name}.md` && e.location && e.quote)), `${name}: provenance`);
  }
});
