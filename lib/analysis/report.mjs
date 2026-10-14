/**
 * The text of an analysis report (DS022 "Analysis procedures"). Every sentence is a `line_*` reply wire of the conversation layer
 * (config/knowledge/conversation-v1/0080-analysis-lines.sop, DS023): the code chooses the line from the structure of the analysis
 * packet and fills its slots; it holds no phrasing.
 *
 *   finding   line_finding_<integrity id> when the layer phrases that rule, else line_finding (slots severity, message, witness, rule,
 *             procedure; the message is the integrity wire's own), then one line_finding_evidence per document wire (document,
 *             location, quote) or line_finding_evidence_no_quote
 *   measure   line_report_<predicate> when the layer phrases it (slots: the variable names of the report line), else line_report_row
 */
import {line, variants, joinList} from '../../sop/replies.mjs';
import {termText} from './view.mjs';

const shown = (value, label) => (label ? `${label}` : typeof value === 'string' ? value : termText(value));

function findingLines(f) {
  const slots = {severity: line(`severity_${f.severity === 'warning' ? 'warning' : 'error'}`), message: f.rule.message ?? f.rule.id, witness: shown(f.witness, f.witness_label), rule: f.rule.id, procedure: f.procedure};
  const own = `finding_${f.rule.id}`;
  const out = [variants(`line_${own}`).length ? line(own, slots) : line('finding', slots)];
  out.push(...evidenceLines(f.evidence));
  return out;
}

/** One line per distinct (document, location, quote) of the evidence; a location that already names the document is not prefixed twice. */
function evidenceLines(evidence) {
  const seen = new Set(), out = [];
  for (const e of evidence) {
    const document = e.document ?? '';
    const location = document && String(e.location ?? '').startsWith(document + ', ') ? String(e.location).slice(document.length + 2) : e.location ?? '';
    const key = `${document}\u0000${location}\u0000${e.quote ?? e.wire}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.quote ? line('finding_evidence', {document, location, quote: e.quote}) : line('finding_evidence_no_quote', {document, location, wire: e.wire}));
  }
  return out;
}

function measureLine(m) {
  const slots = Object.fromEntries(Object.entries(m.values).map(([k, v]) => [k, shown(v, m.labels?.[k])]));
  if (variants(`line_report_${m.predicate}`).length) return line(`report_${m.predicate}`, slots);
  return line('report_row', {predicate: m.predicate, values: joinList(Object.values(slots).map(String))});
}

/** The report text of an analysis packet. */
export function renderReport(result) {
  const out = [line('analysis_header', {documents: joinList([...new Set(result.documents.map(d => d.document))]), procedures: joinList(result.procedures.map(p => p.id))})];
  if (result.routes?.unsupported?.length) out.push(line('analysis_unsupported', {count: result.routes.unsupported.length, engine: result.routes.requested ?? ''}));
  out.push(result.findings.length ? line('analysis_counts', result.counts) : line('analysis_no_findings'));
  for (const f of result.findings) out.push(...findingLines(f));
  for (const p of result.procedures) {
    const own = result.measures.filter(m => m.procedure === p.id);
    if (!own.length) continue;
    out.push(line('analysis_procedure', {procedure: p.id}));
    for (const m of own) out.push(measureLine(m));
  }
  return out.join('\n');
}
