/**
 * Loads the built world-v1 circuits (datasets_sources/world-kb/circuits/) into the base memory `world-v1` through the product
 * library (lib/chat-data/memories.mjs: one validation of the whole program over core-min and the circuits, the facts into the SQLite
 * strategy, provenance). Administrator action: the approver is named by --approved-by (default worldkb-agent, recorded as the
 * loader, not as an independent review). The memory imports core-min (and core-en when --with-core-en is given and the seed exists, and
 * then also the common-sense layer commonsense-v1 unless --without-commonsense is given, with the layer mined from the problem books,
 * commonsense-books-v1, unless --without-books-commonsense is given, and the ShareAlike layer conceptnet-bysa-v1 (CC BY-SA 4.0) unless --without-bysa is given: the chat's default base carries common sense, and the
 * self layer assistant-v1 unless --without-assistant is given, with its generated memory statistics, tools/assistant/memory-statistics.mjs).
 *   node tools/world-kb/load.mjs [--id world-v1] [--strategy sqlite] [--exact] [--replace] [--root <chat data root>] [--with-core-en] [--without-commonsense] [--without-books-commonsense] [--without-bysa] [--without-assistant]
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {ensureSeedMemories} from '../../lib/knowledge-seeds.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const id = opt('--id', 'world-v1');
const strategy = opt('--strategy', 'sqlite');
const config = JSON.parse(fs.readFileSync(path.join(project, 'config/runtime.json'), 'utf8'));
if (opt('--root', null)) config.chatData.root = path.resolve(opt('--root'));
const memories = new BaseMemories({chatData: ChatData.open(config), memory: config.memory});
ensureSeedMemories(memories, {strategy});
if (args.includes('--replace') && memories.list().some(m => m.id === id)) memories.delete(id);
const dir = path.join(project, 'datasets_sources', 'world-kb', 'circuits');
const circuits = fs.readdirSync(dir).filter(f => f.endsWith('.sop')).sort().map(f => ({name: f.replace(/^\d+-/, '').replace(/\.sop$/, ''), text: fs.readFileSync(path.join(dir, f), 'utf8')}));
const imports = ['core-min'];
if (args.includes('--with-core-en')) { if (!memories.list().some(m => m.id === 'core-en')) throw new Error('core-en is not a seed memory yet'); imports.push('core-en'); }
if (args.includes('--with-core-en') && !args.includes('--without-commonsense')) { if (!memories.list().some(m => m.id === 'commonsense-v1')) throw new Error('commonsense-v1 is not a seed memory yet'); imports.push('commonsense-v1'); }
// The common sense mined from the owner's problem books (tools/knowledge-mining) sits over commonsense-v1.
if (args.includes('--with-core-en') && !args.includes('--without-commonsense') && !args.includes('--without-books-commonsense') && memories.list().some(m => m.id === 'commonsense-books-v1')) imports.push('commonsense-books-v1');
// The ShareAlike common-sense layer (ConceptNet CC BY-SA edges, owner decision of 2026-10-02): CC BY-SA 4.0 passes to world-v1.
if (args.includes('--with-core-en') && !args.includes('--without-commonsense') && !args.includes('--without-bysa') && memories.list().some(m => m.id === 'conceptnet-bysa-v1')) imports.push('conceptnet-bysa-v1');
// The self layer (assistant-v1): who the assistant is and what its memory holds; its statistics are generated after the load.
if (args.includes('--with-core-en') && !args.includes('--without-assistant')) { if (!memories.list().some(m => m.id === 'assistant-v1')) throw new Error('assistant-v1 is not a seed memory yet'); imports.push('assistant-v1'); }
const t0 = Date.now();
const manifest = memories.importMemory({
  id, name: 'World knowledge v1 (Wikidata subset)', strategy, exact: args.includes('--exact'), imports, circuits,
  description: 'A small encyclopedia mechanically built from a Wikidata subset (CC0): countries, capitals, cities, languages, currencies, famous people, organizations, chemical elements, planets, notable works, over the common-sense layer commonsense-v1 (WordNet classes, ConceptNet CC BY 4.0 typical relations, rules for classes, time, family, geography and units). Open-world: nothing is closed. Sources and licences: docs/specs/DS011-source-rights.md.',
  approvedBy: opt('--approved-by', 'worldkb-agent'), reason: 'world-v1 initial load (mechanical Wikidata mapping)', source: 'Wikidata (CC0) via WDQS, tools/world-kb',
});
let statistics = null;
if (imports.includes('assistant-v1')) {
  const run = spawnSync(process.execPath, [path.join(project, 'tools/assistant/memory-statistics.mjs'), '--memory', id, ...(opt('--root', null) ? ['--root', opt('--root')] : [])], {encoding: 'utf8'});
  if (run.status !== 0) throw new Error('memory statistics failed: ' + run.stderr);
  statistics = JSON.parse(run.stdout.trim().split('\n').at(-1));
}
console.log(JSON.stringify({id, strategy, imports, circuits: circuits.length, facts: manifest.facts, statistics, seconds: (Date.now() - t0) / 1000}));
