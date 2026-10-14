#!/usr/bin/env node
/**
 * Consistency check of commonsense-v1 against the world facts: every integrity constraint of the layer is asked for a sample of witnesses
 * (`violation ID WITNESS`, keyed by the witness, through the product path askMemory) drawn from the world-v1 entity table: persons for the
 * lifetime and family constraints, countries and cities for geography, a mixed sample for the class constraints. (A whole-memory violation
 * query does not fit the slice limits and is reported incomplete; the sample is the check.) A violation is a data problem or a wrong
 * constraint; both are reported, never hidden.
 *   QF_CHAT_ROOT=<chat data root> node tools/commonsense/integrity.mjs [--base world-v1] [--per-kind 150] [--seed 1] [--out <file.json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSession} from '../eval/lib/session.mjs';
import {askMemory} from '../../reasoning/slice/index.mjs';
import {parse} from '../../sop/knowledge/index.mjs';
import {seedCircuits} from '../../lib/knowledge-seeds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const s = openSession({base: opt('--base', 'world-v1'), id: 'cs-integrity-' + process.pid});
const session = s.store.get('cs', 'i', 'main').agent.session;
const theory = s.theories.get([...s.sessions.baseCircuits(s.id), ...s.sessions.circuits(s.id)]);
const ids = seedCircuits('commonsense-v1').flatMap(c => parse(c.text).wires.filter(w => w.type === 'integrity').map(w => ({id: w.id, file: c.file, severity: w.fields.find(f => f.key === 'severity')?.value.trim() ?? 'error'})));
const entities = JSON.parse(fs.readFileSync(path.join(ROOT, 'datasets_sources/world-kb/entities.json'), 'utf8'));
const perKind = Number(opt('--per-kind', 150));
let seed = Number(opt('--seed', 1));
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const sample = kinds => { const ids = Object.keys(entities).filter(id => kinds.includes(entities[id].kind)).sort(); const out = []; while (out.length < Math.min(perKind, ids.length)) { const id = ids[Math.floor(rand() * ids.length)]; if (!out.includes(id)) out.push(id); } return out; };
const SAMPLES = {person: sample(['person']), place: [...sample(['country']), ...sample(['city'])], any: sample(['person', 'country', 'city', 'company', 'film', 'literary_work', 'element', 'language', 'university'])};
const witnessKind = id => (/^cs_(i|fam)_/.test(id) ? 'person' : /^cs_geo_/.test(id) ? 'place' : 'any');
const out = [];
for (const c of ids) {
  const t0 = Date.now();
  const found = [], open = [];
  for (const w of SAMPLES[witnessKind(c.id)]) {
    let r;
    try { r = askMemory({theory, repo: s.sessions.repository(s.id), session, query: `@q query\n  mode exists\n  where violation ${c.id} ${w}\n`, limits: {maxLookups: 300000, maxProbes: 600000, maxFacts: 60000, retrievalMs: 60000}, budget: {timeoutMs: 60000}}); }
    catch (error) { r = {status: 'error', error: error.message}; }
    if (r.status === 'supported') found.push(w); else if (r.status !== 'unknown') open.push(`${w}:${r.status}`);
  }
  out.push({...c, witnesses_checked: SAMPLES[witnessKind(c.id)].length, violations: found.length, witnesses: found.slice(0, 20), undecided: open.length, undecided_examples: open.slice(0, 5), ms: Date.now() - t0});
  console.error(c.id, 'checked', SAMPLES[witnessKind(c.id)].length, 'violations', found.length, 'undecided', open.length, Date.now() - t0 + 'ms');
}
s.close();
const report = {base: opt('--base', 'world-v1'), ran_at: new Date().toISOString(), constraints: out};
if (opt('--out', null)) { fs.mkdirSync(path.dirname(path.resolve(opt('--out'))), {recursive: true}); fs.writeFileSync(path.resolve(opt('--out')), JSON.stringify(report, null, 1) + '\n'); }
console.log(JSON.stringify(out.map(({id, severity, witnesses_checked, violations, witnesses, undecided}) => ({id, severity, witnesses_checked, violations, witnesses: witnesses.slice(0, 5), undecided}))));
process.exit(0);
