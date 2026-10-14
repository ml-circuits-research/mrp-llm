/**
 * Command line of the knowledge validator: `node sop/knowledge/cli.mjs [--authoring] FILE...`, `--grammar` (Markdown table) and
 * `--grammar-compact [type,type]` (the list quoted by the authoring skill). `eval/smoke-reasoning/validator.mjs` delegates here.
 */
import fs from 'node:fs';
import {grammarMarkdown, grammarCompact} from './grammar.mjs';
import {validateProgram} from './validate.mjs';

export function main(args) {
  if (args[0] === '--grammar') { console.log(grammarMarkdown()); return 0; }
  if (args[0] === '--grammar-compact') { console.log(grammarCompact({only: args[1] ? args[1].split(',') : null})); return 0; }
  const authoring = args.includes('--authoring');
  const files = args.filter(a => a !== '--authoring').map(a => ({name: a, text: fs.readFileSync(a, 'utf8'), role: /query/.test(a) ? 'query' : 'knowledge'}));
  const r = validateProgram(files, {authoring});
  for (const p of r.problems) console.log((p.file ?? '') + ':' + (p.line ?? '?') + ' ' + (p.severity === 'warning' ? 'warning ' : '') + p.code + ' ' + p.message);
  console.log(r.ok ? 'OK' : r.problems.length + ' problem(s)');
  return r.ok ? 0 : 1;
}
