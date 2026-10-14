/**
 * Library of tools/convert-ontology.mjs. One-way migration of the retired ontology grammar (a separate host grammar that the Lexicon used to read) into circuits of the
 * knowledge grammar (DS004 "Lexicon wires", linking proposal M1):
 *
 *   predicate  role NAME TYPE / label / alias   ->  predicate (args + role lines + labels) and one `lexeme` per language holding the former aliases
 *   entity     kind / label / alias             ->  entity (unchanged; every class named by a kind or a role is declared as a class entity)
 *   concept    is_a / label / alias             ->  entity of kind class plus `is_a` facts
 *
 *   node tools/convert-ontology.mjs --in config/ontology.sop --out config/knowledge/demo/0001-vocabulary.sop [--known person,organization,...]
 *   node tools/convert-ontology.mjs --in predicates.sop --out predicates.sop --blocks     # keep `# block KEY` markers (shared worlds)
 *
 * The conversion is lossless for linking: the compiled lexicon of the output links the same strings to the same symbols
 * (the differential run of tools/linking/differential.mjs, archived on 2026-10-03 in probably_obsolete/eval-cleanup-2026-10-03/, checked it on the dataset rows).
 */
import {parse, tokens} from '../sop/knowledge/lexical.mjs';
import {ARG_TYPES, CLASS_KIND, ROOT_CLASS} from '../sop/knowledge/grammar.mjs';

const unquote = s => (s?.startsWith('"') ? JSON.parse(s) : s);
const q = s => JSON.stringify(s);
const values = (w, key) => w.fields.filter(f => f.key === key).map(f => f.value.trim());
const first = (w, key) => values(w, key)[0];

/** Converts ontology text; returns {text, blocks: Map(id -> text), classes: Set}. `known` are classes declared elsewhere (core-min). */
export function convertOntology(source, {known = []} = {}) {
  const {wires, errors} = parse(source);
  if (errors.length) throw Error(`ontology text: ${errors[0].message} (line ${errors[0].line})`);
  const blocks = new Map();
  const classes = new Set();
  const useClass = c => { if (c && !ARG_TYPES.includes(c) && c !== CLASS_KIND) classes.add(c); };
  for (const w of wires) {
    if (w.type === 'predicate') {
      const roles = values(w, 'role').map(line => { const [name, type] = tokens(line); return {name, type}; });
      const args = first(w, 'args');
      const positional = !roles.length && args ? tokens(args).map((type, i) => ({name: ['subject', 'object'][i], type})) : roles;
      for (const r of positional) useClass(r.type);
      let text = `@${w.id} predicate\n  args ${positional.map(r => `${r.name}:${ARG_TYPES.includes(r.type) ? r.type : 'entity'}`).join(' ')}\n`;
      for (const r of positional) text += `  role ${r.name} ${r.type}\n`;
      const labels = values(w, 'label'), aliases = values(w, 'alias');
      for (const l of labels) text += `  label ${l}\n`;
      for (const key of ['description', 'domain']) if (first(w, key) !== undefined) text += `  ${key} ${first(w, key)}\n`;
      for (const r of values(w, 'reading')) text += `  reading ${r}\n`;
      if (first(w, 'describe_rank') !== undefined) text += `  describe_rank ${first(w, 'describe_rank')}\n`;
      const byLanguage = new Map();
      for (const a of aliases) { const [language, ...rest] = tokens(a); (byLanguage.get(language) ?? byLanguage.set(language, []).get(language)).push(rest[0]); }
      for (const [language, forms] of byLanguage) {
        text += `\n@lx_${w.id}_${language} lexeme\n  of ${w.id}\n  language ${language}\n  pos verb\n${forms.map(f => `  form ${f}\n`).join('')}  frame ${positional.map(r => r.name).join(' ')}\n  source "converted from the ontology aliases of ${w.id}"\n`;
      }
      blocks.set(w.id, text.trimEnd() + '\n');
    } else if (w.type === 'entity') {
      const kind = first(w, 'kind');
      if (kind && kind !== ROOT_CLASS) useClass(kind);
      let text = `@${w.id} entity\n`;
      if (kind) text += `  kind ${kind}\n`;
      for (const key of ['label', 'alias']) for (const v of values(w, key)) text += `  ${key} ${v}\n`;
      if (first(w, 'domain') !== undefined) text += `  domain ${first(w, 'domain')}\n`;
      blocks.set(w.id, text);
    } else if (w.type === 'concept') {
      let text = `@${w.id} entity\n  kind ${CLASS_KIND}\n`;
      for (const key of ['label', 'alias']) for (const v of values(w, key)) text += `  ${key} ${v}\n`;
      for (const parent of values(w, 'is_a')) { useClass(parent); text += `\n@isa_${w.id}_${parent} fact\n  holds is_a ${w.id} ${parent}\n  valid timeless\n`; }
      classes.delete(w.id);
      blocks.set(w.id, text);
    } else throw Error(`ontology text: wire @${w.id} of type ${w.type} is not an ontology declaration`);
  }
  for (const w of wires) if (w.type === 'concept') classes.delete(w.id);
  const declared = new Set([...known, ...wires.map(w => w.id)]);
  const missing = [...classes].filter(c => !declared.has(c)).sort();
  const classText = missing.map(c => `@${c} entity\n  kind ${CLASS_KIND}\n  label en ${q(c.replaceAll('_', ' '))}\n`).join('\n');
  if (classText) blocks.set('classes', classText);
  const ordered = [...blocks.entries()];
  return {text: (classText ? classText + '\n' : '') + ordered.filter(([k]) => k !== 'classes').map(([, t]) => t).join('\n'), blocks, classes: new Set(missing)};
}

