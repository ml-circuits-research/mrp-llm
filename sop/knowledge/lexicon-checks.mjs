/**
 * Cross-wire checks of the lexicon wires (DS004 "Lexicon wires"): `predicate` roles and labels, `lexeme` frames, restrictions and
 * shared forms, `entity` classes and labels, and the round trip of every lexeme form through the relation linker. They run over
 * the whole program, so a base memory is validated over its layers (imports first, then its own circuits).
 */
import {ARG_TYPES, CLASS_KIND, ROOT_CLASS, COPULA_READINGS} from './grammar.mjs';
import {Lexicon} from '../lexicon.mjs';
import {linkRelation, predicateRoleNames} from '../linking.mjs';
import {phraseKey} from '../text-keys.mjs';

/** The argument specs {role, type} a predicate with only `role` lines declares (class types are entity arguments). */
export const roleArgSpecs = roles => (roles ? roles.map(r => ({role: r.role, type: ARG_TYPES.includes(r.type) ? r.type : 'entity'})) : null);

const f1 = (w, key) => w.fields.find(x => x.key === key);
const fAll = (w, key) => w.fields.filter(x => x.key === key);

export function lexiconChecks({files, allWires, ctxs, problems, linking = false}) {
  const add = (code, w, line, message, severity) => problems.push({code, file: w.file, line, message, wire: w.id, ...(severity ? {severity} : {})});
  const predicates = new Map(allWires.filter(w => w.type === 'predicate').map(w => [w.id, w]));
  const entities = new Map(allWires.filter(w => w.type === 'entity').map(w => [w.id, w]));
  const classes = new Set([...entities].filter(([, w]) => f1(w, 'kind')?.value.trim() === CLASS_KIND).map(([id]) => id));
  const isClass = c => ARG_TYPES.includes(c) || classes.has(c);
  const specOf = id => {
    for (const {ctx} of ctxs) { const s = ctx.argSpecs?.[id]; if (s) return {args: s}; }
    return {};
  };
  const rolesOf = id => { for (const {ctx} of ctxs) { const r = ctx.roleSpecs?.[id]; if (r) return r; } return null; };
  /** Role names of a predicate in position order (named args, role lines, or subject/object by position). */
  const namesOf = id => {
    const args = specOf(id).args, roles = rolesOf(id);
    if (roles) return roles.map(r => r.role);
    if (args?.length && args.every(a => a.role)) return args.map(a => a.role);
    return args && args.length <= 2 ? ['subject', 'object'].slice(0, args.length) : null;
  };

  for (const w of predicates.values()) {
    const args = specOf(w.id).args, roles = rolesOf(w.id);
    if (roles) {
      const names = roles.map(r => r.role);
      if (new Set(names).size !== names.length) add('duplicate_role', w, w.line, 'a role may name one argument position only');
      for (const r of roles) if (!isClass(r.type)) add('role_class_unknown', w, r.line, `role ${r.role} ${r.type}: ${r.type} is neither a value type (${ARG_TYPES.join(' ')}) nor a class declared in this memory or its imports`);
      if (args) {
        const named = args.every(a => a.role);
        const agree = args.length === roles.length && args.every((a, i) => (!named || a.role === roles[i].role) && (a.type === roles[i].type || (a.type === 'entity' && !ARG_TYPES.includes(roles[i].type))));
        if (!agree) add('args_disagree_with_roles', w, f1(w, 'args').line, `args and role lines of ${w.id} disagree (same number, order and names of roles; a class in a role line needs an entity argument)`);
      }
    }
    const seen = new Set();
    for (const l of fAll(w, 'label')) { const lang = l.value.trim().split(/\s+/)[0]; if (seen.has(lang)) add('label_duplicate_language', w, l.line, `${w.id} has two labels in ${lang}; a label is one display form per language (more forms are lexemes)`); seen.add(lang); }
    // copula readings (DS014): the roles a reading needs
    const names = namesOf(w.id) ?? [];
    const readings = fAll(w, 'reading').map(x => x.value.trim());
    if (new Set(readings).size !== readings.length) add('repeated_reading', w, f1(w, 'reading').line, `${w.id} repeats a reading`);
    for (const r of readings) {
      if (!COPULA_READINGS.includes(r)) continue;
      const ok = r === 'location' ? names.length >= 2 && names[0] === 'subject' : names.length >= 1 && names[0] === 'subject' && (r === 'describe' || (names.length === 2 && names[1] === 'object'));
      if (!ok) add('reading_roles_mismatch', w, f1(w, 'reading').line, `reading ${r} needs ${r === 'location' ? 'subject first and a second role' : r === 'describe' ? 'subject as its first role' : 'the roles subject and object'}`);
    }
    if (f1(w, 'describe_rank') && !fAll(w, 'reading').some(x => x.value.trim() === 'describe')) add('describe_rank_needs_describe', w, f1(w, 'describe_rank').line, 'describe_rank needs reading describe');
  }

  const lexemesOf = new Map();
  for (const w of allWires.filter(x => x.type === 'lexeme')) {
    const of = f1(w, 'of')?.value.trim();
    (lexemesOf.get(of) ?? lexemesOf.set(of, []).get(of)).push(w);
    if (!predicates.has(of)) { add('unknown_predicate', w, f1(w, 'of')?.line ?? w.line, `lexeme of ${of}: no such predicate in this memory or its imports`); continue; }
    const names = namesOf(of);
    const frame = f1(w, 'frame')?.value.trim().split(/\s+/).filter(Boolean) ?? [];
    for (const r of frame) if (names && !names.includes(r)) add('frame_role_undeclared', w, f1(w, 'frame').line, `frame role ${r} is not a role of ${of} (${names.join(', ')})`);
    if (names && frame.length && frame.every(r => names.includes(r)) && frame.length !== names.length) add('frame_incomplete', w, f1(w, 'frame').line, `the frame realizes ${frame.length} of the ${names.length} roles of ${of}`, 'warning');
    for (const x of fAll(w, 'restrict')) {
      const [role, cls] = x.value.trim().split(/\s+/);
      if (names && !names.includes(role)) add('frame_role_undeclared', w, x.line, `restrict role ${role} is not a role of ${of}`);
      if (!classes.has(cls) && cls !== ROOT_CLASS) add('restrict_class_unknown', w, x.line, `restrict ${role} ${cls}: ${cls} is not a class declared in this memory or its imports`);
    }
  }
  // Only the circuits of a base memory (validateProgram option linking) are reached through language; an engine test world refers to its predicates by id.
  if (linking) for (const w of predicates.values()) if (!lexemesOf.has(w.id) && !fAll(w, 'label').length) add('predicate_without_lexeme', w, w.line, `${w.id} has no label and no lexeme: no phrase can link to it`, 'warning');

  // A form shared by two predicates with the same frame length must say how they differ (restrict, or distinct weights).
  const shared = new Map();
  for (const w of allWires.filter(x => x.type === 'lexeme' && predicates.has(f1(x, 'of')?.value.trim()))) {
    const language = f1(w, 'language')?.value.trim(), length = f1(w, 'frame')?.value.trim().split(/\s+/).filter(Boolean).length;
    for (const form of fAll(w, 'form')) { let text; try { text = JSON.parse(form.value.trim()); } catch { continue; } const key = `${language}|${length}|${phraseKey(text)}`; (shared.get(key) ?? shared.set(key, []).get(key)).push({w, form: text, line: form.line}); }
  }
  for (const group of shared.values()) {
    const preds = new Set(group.map(g => f1(g.w, 'of').value.trim()));
    if (preds.size < 2) continue;
    const weights = group.map(g => f1(g.w, 'weight')?.value.trim());
    const distinct = weights.every(Boolean) && new Set(weights).size === weights.length;
    for (const g of group) if (!fAll(g.w, 'restrict').length && !distinct) add('ambiguous_form_undeclared', g.w, g.line, `the form ${JSON.stringify(g.form)} is shared by ${[...preds].join(' and ')} with the same frame length; declare restrict or distinct weight lines`);
  }

  for (const w of entities.values()) {
    const kind = f1(w, 'kind')?.value.trim();
    if (kind && kind !== CLASS_KIND && !classes.has(kind) && kind !== ROOT_CLASS) add('entity_kind_unknown', w, f1(w, 'kind').line, `kind ${kind}: ${kind} is not a class declared in this memory or its imports`);
    if (!fAll(w, 'label').length) add('entity_without_label', w, w.line, `${w.id} has no label: mentions cannot be shown or resolved`);
    const seen = new Set();
    for (const l of fAll(w, 'label')) { const lang = l.value.trim().split(/\s+/)[0]; if (seen.has(lang)) add('label_duplicate_language', w, l.line, `${w.id} has two labels in ${lang}; a label is one display form per language (more forms are aliases)`); seen.add(lang); }
  }
  const plain = new Map();
  for (const w of entities.values()) for (const l of fAll(w, 'label')) {
    const [lang, ...rest] = l.value.trim().split(/\s+/);
    let text; try { text = JSON.parse(rest.join(' ')); } catch { continue; }
    const key = `${lang}|${text.toLowerCase()}`;
    (plain.get(key) ?? plain.set(key, []).get(key)).push({w, line: l.line, notability: Number(f1(w, 'notability')?.value ?? NaN)});
  }
  for (const [key, group] of plain) {
    if (group.length < 2) continue;
    const ranked = group.filter(g => Number.isFinite(g.notability)).map(g => g.notability).sort((a, b) => b - a);
    if (ranked.length === group.length && ranked[0] > ranked[1]) continue;
    add('label_collision', group[0].w, group[0].line, `the label ${JSON.stringify(key.split('|')[1])} (${key.split('|')[0]}) is the plain label of ${group.map(g => g.w.id).join(' and ')} without a notability that separates them`, 'warning');
  }

  // Round trip: every lexeme form must link, through the relation linker, to its own predicate.
  if (!problems.some(p => p.severity !== 'warning' && ['bad_header', 'bad_indent', 'bad_field_line', 'duplicate_id', 'unknown_field'].includes(p.code)) && lexemesOf.size) {
    let lexicon;
    try { lexicon = Lexicon.fromCircuits(files.map(({name, text}) => ({name, text}))); } catch { lexicon = null; }
    if (lexicon) {
      for (const [of, list] of lexemesOf) {
        const predicate = lexicon.predicates[of];
        if (!predicate || !predicateRoleNames(predicate)) continue;
        for (const w of list) {
          const frame = f1(w, 'frame')?.value.trim().split(/\s+/).filter(Boolean) ?? [];
          const declared = fAll(w, 'restrict').length > 0 || f1(w, 'weight');
          for (const form of fAll(w, 'form')) {
            let text; try { text = JSON.parse(form.value.trim()); } catch { continue; }
            const used = frame.length ? frame : predicateRoleNames(predicate);
            const r = linkRelation(text, used, lexicon, {exact: true, relations: null});
            // A shared form that declares a restriction or a weight is legal when the scored linker keeps this predicate among the alternatives of the
            // reading it takes (the winner is decided by the entities of a message, which a lexicon check does not have).
            const kept = r.status === 'bound' && r.id !== of && declared && ['weight', 'evidence', 'constraint', 'facts'].includes(r.decided_by) && (r.scored_alternatives ?? []).some(c => c.id === of);
            const ok = (r.status === 'bound' && r.id === of) || kept || (r.status === 'ambiguous' && declared && r.candidates.some(c => c.id === of));
            if (!ok) add('form_does_not_link', w, form.line, `the form ${JSON.stringify(text)} of ${of} does not link back to ${of} (${r.status}${r.candidates ? ': ' + r.candidates.map(c => c.id).join(', ') : ''})`);
          }
        }
      }
    }
  }
}
