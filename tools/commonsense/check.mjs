#!/usr/bin/env node
/**
 * Mechanical checks of the common-sense layer commonsense-v1 (config/knowledge/commonsense-v1/):
 *   1. the knowledge validator (sop/knowledge validateProgram: grammar, references, arity, safety, stratification, lexicon checks) over the
 *      layers in import order: core-min, core-en, commonsense-v1, and with --world the world-v1 circuits on top (as the chat loads them);
 *   2. the compiled lexicon of the layers (sop/lexicon.mjs) must build.
 * Prints the problems grouped by code; exits 1 on any error-severity problem.
 *   node tools/commonsense/check.mjs [--world] [--extra <file.sop>]...   (--extra: a candidate circuit validated on top of the layers)
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProgram} from '../../sop/knowledge/validate.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {seedLayers} from '../../lib/knowledge-seeds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const files = seedLayers('commonsense-v1').map(c => ({name: c.name, text: c.text, role: 'knowledge'}));
if (args.includes('--world')) {
  const dir = path.join(ROOT, 'datasets_sources/world-kb/circuits');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sop')).sort()) files.push({name: `world-v1:${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8'), role: 'knowledge'});
}
args.forEach((a, i) => { if (a === '--extra') files.push({name: `extra:${path.basename(args[i + 1])}`, text: fs.readFileSync(args[i + 1], 'utf8'), role: 'knowledge'}); });
const t0 = Date.now();
const r = validateProgram(files, {authoring: true});
const errors = r.problems.filter(p => p.severity !== 'warning'), warnings = r.problems.filter(p => p.severity === 'warning');
const group = list => Object.entries(list.reduce((m, p) => ((m[p.code] ??= []).push(p), m), {})).map(([code, ps]) => ({code, count: ps.length, examples: ps.slice(0, 4).map(p => `${p.file ?? ''}:${p.line ?? '?'} ${p.message}`)}));
let lexicon = null;
try { lexicon = Lexicon.fromCircuits(files.map(({name, text}) => ({name, text}))); } catch (error) { errors.push({code: 'lexicon_failed', message: error.message}); }
console.log(JSON.stringify({files: files.length, ms: Date.now() - t0, errors: group(errors), warnings: group(warnings).map(g => ({code: g.code, count: g.count, examples: g.examples.slice(0, 2)})), entities: lexicon ? Object.keys(lexicon.entities).length : null, predicates: lexicon ? Object.keys(lexicon.predicates).length : null}, null, 1));
process.exit(errors.length ? 1 : 0);
