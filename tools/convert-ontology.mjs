#!/usr/bin/env node
/**
 * Converts text of the retired ontology grammar into knowledge circuits (see lib/ontology-conversion.mjs):
 *   node tools/convert-ontology.mjs --in config/ontology.sop --out config/knowledge/demo/0001-vocabulary.sop [--known person,organization,...]
 *   node tools/convert-ontology.mjs --in predicates.sop --out converted.sop --blocks     # keep `# block KEY` markers (shared worlds)
 */
import fs from 'node:fs';
import {convertOntology} from '../lib/ontology-conversion.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const input = opt('--in'), output = opt('--out');
  if (!input || !output) { console.error('usage: node tools/convert-ontology.mjs --in FILE --out FILE [--known a,b] [--blocks]'); process.exit(2); }
  const source = fs.readFileSync(input, 'utf8');
  const {text, blocks} = convertOntology(source, {known: (opt('--known', '') || '').split(',').filter(Boolean)});
  if (args.includes('--blocks')) {
    const header = source.split('\n').filter(l => l.startsWith('#') && !l.startsWith('# block')).join('\n');
    fs.writeFileSync(output, (header ? header + '\n\n' : '') + [...blocks.entries()].map(([id, t]) => `# block ${id}\n${t.trimEnd()}\n`).join('\n'));
  } else fs.writeFileSync(output, text);
  console.log(JSON.stringify({in: input, out: output, blocks: blocks.size}));
}
