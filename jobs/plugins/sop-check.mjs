/**
 * Job-runner checks plugin of ChatSOP (Ploinky Workers jobs): the reply (format text) is a SOP program. It must pass the knowledge validator (authoring mode,
 * warnings ignored) and, when the item has a source `text` (a chunk of an attachment), every `quote` must be a contiguous passage
 * of it (lib/ingest/checks.mjs). Parameters: `params.sop_role` (default "knowledge").
 */
import {validateProgram} from '../../sop/knowledge/index.mjs';
import {quoteProblems} from '../../lib/ingest/checks.mjs';

const stripFences = t => String(t ?? '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

export function parse(text) {
  return {sop: stripFences(text)};
}

export function check(item, output, ctx = {}) {
  const sop = output.sop ?? stripFences(output.text);
  if (!sop) return {ok: false, empty: true, problems: ['empty SOP program']};
  let problems;
  try {
    problems = validateProgram([{name: 'work.sop', text: sop, role: ctx.params?.sop_role ?? 'knowledge'}], {authoring: true}).problems
      .filter(p => p.severity !== 'warning').map(p => `${p.code}: ${p.message}`);
  } catch (e) { problems = [`validator error: ${e.message}`]; }
  if (!problems.length && typeof item.text === 'string') problems = quoteProblems(sop, item.text).map(p => `${p.code} (@${p.wire}): ${p.message}`);
  return problems.length ? {ok: false, problems, hint: 'Fix only the listed wires; keep the rest unchanged.'} : {ok: true};
}
