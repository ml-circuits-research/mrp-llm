#!/usr/bin/env node
/**
 * Build config/knowledge/core-en/ from the authoring batches' JSON (datasets_sources/core-en/tasks/<area>/output/<area>.json).
 *
 * The batches are proposals: this script lints them (closed role and class inventories, the form convention, shared forms
 * that declare no restrict or weight, duplicate ids), drops what it can prove wrong and reports it, then writes the reviewed
 * circuits in the knowledge grammar (predicate, lexeme, entity, fact, rule wires). It never edits sop/, lib/ or server/.
 *
 *   node tools/linking/core-en/build.mjs [--check]     --check lints and reports without writing
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {phraseKey} from '../../../sop/linking.mjs';
import {ROLE_NAMES} from '../../../sop/enums.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(ROOT, 'datasets_sources/core-en');
const OUT = join(ROOT, 'config/knowledge/core-en');
const CORE_MIN_CLASSES = new Set(['class', 'entity', 'person', 'organization', 'place', 'occupation', 'property', 'unit']);
const CORE_MIN_PREDICATES = new Set(['is_a']);
const VALUE_TYPES = new Set(['entity', 'integer', 'text', 'time', 'value']);
const READINGS = new Set(['class', 'occupation', 'attribute', 'identity', 'location', 'describe']);
const POS = new Set(['verb', 'noun', 'adj', 'prep', 'copula']);
const AREAS = ['upper', 'place', 'people', 'work', 'study', 'commerce', 'move', 'health', 'talk', 'act'];
const SYMBOL = /^[a-z][a-z0-9_]*$/;
const EN_FORM = /^[a-z][a-z' -]*[a-z]$/;
const q = s => JSON.stringify(s);

export function loadBatches() {
  const batches = [];
  for (const area of AREAS) {
    const f = join(SRC, 'tasks', area, 'output', area + '.json');
    if (!existsSync(f)) continue;
    const data = JSON.parse(readFileSync(f, 'utf8'));
    const mf = join(SRC, 'tasks', area, 'output', '.model');
    data.area = area;
    data.model = existsSync(mf) ? readFileSync(mf, 'utf8').trim() : data.model ?? 'unknown';
    batches.push(data);
  }
  // supplement.json: lexemes added after a coverage run; each is appended to its predicate (any area)
  const sf = join(SRC, 'supplement.json');
  if (existsSync(sf)) for (const lx of JSON.parse(readFileSync(sf, 'utf8')).lexemes ?? []) {
    const p = batches.flatMap(b => b.predicates ?? []).find(x => x.id === lx.predicate);
    if (p) (p.lexemes ??= []).push({language: lx.language, pos: lx.pos, frame: lx.frame, forms: lx.forms, restrict: lx.restrict ?? [], weight: lx.weight ?? null, source: lx.source});
  }
  return batches;
}

/** Lint and clean the batches. Returns {predicates, entities, facts, rules, classes, issues, dropped}. */
export function assemble(batches, {mined = null} = {}) {
  const classes = JSON.parse(readFileSync(join(SRC, 'classes.json'), 'utf8'));
  const classIds = new Set(classes.map(c => c.id));
  const issues = [], dropped = [];
  const note = (severity, area, id, message) => issues.push({severity, area, id, message});
  const preds = new Map();
  const generatedRules = [];
  for (const b of batches) for (const p of b.predicates ?? []) {
    if (CORE_MIN_PREDICATES.has(p.id)) { p.coreMin = true; }
    if (!SYMBOL.test(p.id ?? '')) { note('error', b.area, p.id, 'bad predicate id'); continue; }
    if (preds.has(p.id)) { note('error', b.area, p.id, 'duplicate predicate id (also in ' + preds.get(p.id).area + ')'); continue; }
    p.area = b.area; p.model = b.model;
    preds.set(p.id, p);
  }
  const attested = mined ? new Set(mined.phrases.map(x => phraseKey(x.phrase))) : new Set();
  for (const p of preds.values()) {
    const roles = (p.roles ?? []).filter(r => Array.isArray(r) && r.length === 2);
    const names = roles.map(r => r[0]);
    if (!roles.length || roles.length !== (p.roles ?? []).length) note('error', p.area, p.id, 'roles must be [role, type] pairs');
    for (const [r, t] of roles) {
      if (!ROLE_NAMES.includes(r)) note('error', p.area, p.id, 'unknown role ' + r);
      if (!VALUE_TYPES.has(t) && !classIds.has(t)) note('error', p.area, p.id, 'unknown role type ' + t);
    }
    if (new Set(names).size !== names.length) note('error', p.area, p.id, 'repeated role');
    if (!p.label?.en) note('error', p.area, p.id, 'missing English label');
    if (!p.description) note('warning', p.area, p.id, 'missing description');
    for (const r of p.reading ?? []) if (!READINGS.has(r)) note('error', p.area, p.id, 'bad reading ' + r);
    const kept = [];
    for (const lx of p.lexemes ?? []) {
      const where = p.id + '/' + lx.language + '/' + lx.pos;
      if (!/^[a-z]{2,3}$/.test(lx.language ?? '')) { note('error', p.area, where, 'bad language'); continue; }
      // English-only core (owner decision 2026-10-01): other languages are handled at the edges (translation), never in the knowledge
      if (lx.language !== 'en') { dropped.push({id: p.id, forms: lx.forms, why: 'not English: the core holds English only'}); continue; }
      if (!POS.has(lx.pos)) { note('error', p.area, where, 'bad pos ' + lx.pos); continue; }
      const frame = lx.frame ?? [];
      if (!frame.length || !frame.every(r => ROLE_NAMES.includes(r)) || new Set(frame).size !== frame.length) { note("error", p.area, where, "frame " + JSON.stringify(frame) + " is not a set of known roles"); dropped.push({id: p.id, forms: lx.forms, why: 'bad frame'}); continue; }
      const form = EN_FORM;
      const seen = new Set();
      const forms = [];
      for (const raw of lx.forms ?? []) {
        const f = typeof raw === 'string' ? raw.trim() : '';
        if (!form.test(f)) { dropped.push({id: p.id, form: raw, why: 'form convention'}); continue; }
        if (lx.pos === 'copula' && lx.language === 'en' && !/^be\b/.test(f)) { dropped.push({id: p.id, form: f, why: 'copula form does not start with be'}); continue; }
        if (lx.language === 'en' && /^(is|are|was|were|has|does) /.test(f)) { dropped.push({id: p.id, form: f, why: 'inflected form'}); continue; }
        if (lx.language === 'en' && /^(can|could|should|must|may|might|will|would|shall) /.test(f) && !attested.has(phraseKey(f))) { dropped.push({id: p.id, form: f, why: 'modal verb inside an unattested form'}); continue; }
        if (seen.has(f)) continue;
        seen.add(f); forms.push(f);
      }
      if (!forms.length) continue;
      const restrict = (lx.restrict ?? []).filter(r => Array.isArray(r) && r.length === 2 && ROLE_NAMES.includes(r[0]) && classIds.has(r[1]) && !(roles.find(x => x[0] === r[0])?.[1] === r[1]));
      kept.push({language: lx.language, pos: lx.pos, frame, forms, restrict, weight: Number.isInteger(lx.weight) ? lx.weight : null, source: String(lx.source ?? 'authored').replace(/\s+/g, ' ')});
    }
    p.lexemes = kept;
  }
  // One predicate has one role set (the linker binds a phrase and the roles used with it to the predicate whose role set equals
  // them). A lexeme whose frame realizes another role set therefore belongs to a variant predicate `<id>_with_<role>` (extra
  // roles) or `<id>_without_<role>` (fewer roles), and a generated rule projects the richer relation onto the poorer one.
  const EXTRA_TYPE = {recipient: 'person', source: 'entity', destination: 'place', location: 'place', instrument: 'entity', topic: 'entity', time: 'time', object: 'entity'};
  for (const p of [...preds.values()]) {
    const base = p.roles.map(r => r[0]);
    const groups = new Map();
    for (const lx of p.lexemes) {
      const set = [...new Set(lx.frame)].sort().join(' ');
      if (set === [...base].sort().join(' ')) continue;
      if (!groups.has(set)) groups.set(set, []);
      groups.get(set).push(lx);
    }
    for (const [set, lxs] of groups) {
      const names = set.split(' ');
      const extra = names.filter(n => !base.includes(n)), missing = base.filter(n => !names.includes(n));
      const id = p.id + (extra.length ? '_with_' + extra.join('_') : '') + (missing.length ? '_without_' + missing.join('_') : '');
      if (preds.has(id)) { note('error', p.area, id, 'variant id exists'); continue; }
      const order = [...base.filter(n => names.includes(n)), ...extra];
      const roles = order.map(n => [n, (p.roles.find(r => r[0] === n) ?? [n, EXTRA_TYPE[n] ?? 'entity'])[1]]);
      const v = {id, area: p.area, model: p.model, roles, label: {}, description: p.description, reading: [], describe_rank: null, unit: p.unit ?? null, lexemes: lxs, variantOf: p.id};
      p.lexemes = p.lexemes.filter(l => !lxs.includes(l));
      preds.set(id, v);
      const args = names => names.map((n, i) => '?' + n.slice(0, 3) + i);
      const richer = extra.length && !missing.length, poorer = missing.length && !extra.length;
      if (richer || poorer) {
        const big = richer ? v : p, small = richer ? p : v;
        const bigRoles = big.roles.map(r => r[0]), smallRoles = small.roles.map(r => r[0]);
        const vars = Object.fromEntries(bigRoles.map(n => [n, '?' + n]));
        const rule = {id: 'r_' + id, when: [big.id + ' ' + bigRoles.map(n => vars[n]).join(' ')], then: small.id + ' ' + smallRoles.map(n => vars[n]).join(' '), source: 'generated: a variant relation implies its projection', area: p.area};
        generatedRules.push(rule);
      }
    }
  }
  // cross-review verdicts (datasets_sources/core-en/review/<area>/output/review.json, written by a model of the other provider):
  // a flagged form is dropped, the verdict is reported in dropped.json
  const verdicts = new Map();
  for (const area of AREAS) {
    const f = join(SRC, 'review', area, 'output', 'review.json');
    if (!existsSync(f)) continue;
    let list = []; try { list = JSON.parse(readFileSync(f, 'utf8')); } catch { note('warning', area, 'review.json', 'unreadable review file, ignored'); }
    for (const v of Array.isArray(list) ? list : []) verdicts.set(v.predicate + '|' + v.language + '|' + v.form, v);
  }
  for (const p of preds.values()) for (const lx of p.lexemes) lx.forms = lx.forms.filter(f => {
    const v = verdicts.get(p.id + '|' + lx.language + '|' + f);
    if (!v || !['wrong_meaning', 'wrong_direction', 'not_lemma', 'too_vague', 'duplicate_meaning'].includes(v.verdict)) return true;
    dropped.push({id: p.id, form: f, why: 'review: ' + v.verdict + (v.reason ? ' (' + v.reason + ')' : '')});
    return false;
  });
  for (const p of preds.values()) p.lexemes = p.lexemes.filter(lx => lx.forms.length);
  // within one predicate a surface keeps one reading per language and frame length (the first lexeme that holds it)
  for (const p of preds.values()) {
    const seenForm = new Set();
    for (const lx of p.lexemes) lx.forms = lx.forms.filter(f => {
      const key = lx.language + '|' + lx.frame.length + '|' + phraseKey(f);
      if (seenForm.has(key)) { dropped.push({id: p.id, form: f, why: 'second reading of the same surface in one predicate'}); return false; }
      seenForm.add(key); return true;
    });
    p.lexemes = p.lexemes.filter(lx => lx.forms.length);
  }
  // A form shared by two predicates with the same frame length must declare restrict on every holder (lexicon check
  // `ambiguous_form_undeclared`). Otherwise the predicate for which the form is most primary (earliest in its lexeme, then the
  // earlier area) keeps it and the others lose it; every loss is reported in dropped.json.
  const order = [...preds.values()];
  const holders = new Map();
  order.forEach((p, pi) => p.lexemes.forEach(lx => lx.forms.forEach((f, rank) => {
    const key = lx.language + '|' + lx.frame.length + '|' + phraseKey(f);
    if (!holders.has(key)) holders.set(key, []);
    holders.get(key).push({p, lx, rank, pi, f});
  })));
  // a label is also a link form with the natural frame and always keeps its form
  order.forEach((p, pi) => Object.entries(p.label ?? {}).forEach(([lang, text]) => {
    if (!text) return;
    const key = lang + '|' + p.roles.length + '|' + phraseKey(text);
    if (!holders.has(key)) holders.set(key, []);
    holders.get(key).push({p, lx: {restrict: [], label: true}, rank: -1, pi, f: text});
  }));
  const lost = new Map();
  // Role names AND the classes the predicate declares for them: since the scored KnowledgeLinker (M3) two holders whose roles are typed with different
  // classes ("uses": entity, artifact; "uses_currency": country, currency) are told apart by the entities of the message (type clash, class support, facts).
  const setOf = h => ((h.p.roles.length && h.lx.frame ? [...h.lx.frame] : h.p.roles.map(r => r[0])).map(name => name + ':' + (h.p.roles.find(r => r[0] === name)?.[1] ?? '')).sort().join(' '));
  const weighted = [];
  for (const list of holders.values()) {
    if (new Set(list.map(h => h.p.id)).size < 2 || list.every(h => h.lx.restrict.length)) continue;
    // holders with the same role set cannot be told apart by the linker: the most primary one keeps the form
    const bySet = new Map();
    for (const h of list) { const k = setOf(h); if (!bySet.has(k)) bySet.set(k, []); bySet.get(k).push(h); }
    const keep = [];
    for (const group of bySet.values()) {
      const win = [...group].sort((x, y) => x.rank - y.rank || x.pi - y.pi)[0];
      keep.push(win);
      for (const h of group) if (h !== win && h.p.id !== win.p.id && !h.lx.label) {
        if (!lost.has(h.lx)) lost.set(h.lx, new Set());
        lost.get(h.lx).add(h.f);
        dropped.push({id: h.p.id, form: h.f, why: 'shared with ' + win.p.id + ' (same role set, no restrict); kept there'});
      }
    }
    // holders with different role sets are told apart by the roles used; the validator wants distinct weights
    const winners = new Set(keep.map(h => h.p.id));
    const movable = list.filter(h => !h.lx.label && winners.has(h.p.id) && !lost.get(h.lx)?.has(h.f));
    const pids = [...new Set(movable.map(h => h.p.id))];
    if (winners.size > 1 && pids.length > 1) movable.forEach(h => weighted.push({h, weight: 10 - pids.indexOf(h.p.id)}));
  }
  for (const [lx, fs] of lost) lx.forms = lx.forms.filter(f => !fs.has(f));
  for (const {h, weight} of weighted) {
    if (lost.get(h.lx)?.has(h.f)) continue;
    h.lx.forms = h.lx.forms.filter(f => f !== h.f);
    h.p.lexemes.push({...h.lx, forms: [h.f], weight, source: h.lx.source + '; shared surface, told apart by the roles used'});
  }
  for (const p of order) { p.lexemes = p.lexemes.filter(lx => lx.forms.length); }
  for (const p of [...order]) if (p.variantOf && !p.lexemes.length) { preds.delete(p.id); order.splice(order.indexOf(p), 1); generatedRules.splice(0, generatedRules.length, ...generatedRules.filter(r => r.id !== 'r_' + p.id)); }
  for (const p of order) { for (const lx of p.lexemes) lx.attested = lx.forms.filter(f => attested.has(phraseKey(f))).length; }

  // entities
  const entities = new Map(), facts = [], rules = [], classAliases = new Map();
  for (const b of batches) {
    for (const e of b.entities ?? []) {
      if (!SYMBOL.test(e.id ?? '')) { note('error', b.area, e.id, 'bad entity id'); continue; }
      if (e.kind === 'class') { classAliases.set(e.id, e); continue; }
      if (!classIds.has(e.kind)) { note('error', b.area, e.id, 'unknown entity kind ' + e.kind); continue; }
      if (preds.has(e.id) || CORE_MIN_CLASSES.has(e.id)) e.id = e.id + '_' + e.kind;
      if (entities.has(e.id) || classIds.has(e.id)) { note('warning', b.area, e.id, 'duplicate entity id, kept the first'); continue; }
      if (!e.label?.en) { note('error', b.area, e.id, 'missing English label'); continue; }
      e.area = b.area; e.model = b.model;
      entities.set(e.id, e);
    }
    for (const f of b.facts ?? []) facts.push({...f, area: b.area});
    for (const r of b.rules ?? []) rules.push({...r, area: b.area});
  }
  rules.push(...generatedRules);
  // Units: predicates name their unit by the canonical symbol (cents, minutes, years, km, km2, persons ...). The authors also wrote
  // the singular or long spelling as a second entity; it is folded into the canonical one (labels and aliases merged).
  const UNIT_CANON = {minute: 'minutes', year: 'years', centimetre: 'centimetres', metre: 'metres', gram: 'grams', cent: 'cents', kilometre: 'km', square_kilometre: 'km2', person_unit: 'persons'};
  for (const [from, to] of Object.entries(UNIT_CANON)) {
    const a = entities.get(from), b = entities.get(to);
    if (!a || !b) continue;
    b.alias ??= {};
    for (const [lang, text] of Object.entries(a.label ?? {})) if (text && b.label?.[lang] !== text) (b.alias[lang] ??= []).push(text);
    for (const [lang, list] of Object.entries(a.alias ?? {})) (b.alias[lang] ??= []).push(...(list ?? []));
    entities.delete(from);
  }
  const pu = entities.get('persons');
  if (pu && pu.label?.en === 'person') pu.label.en = 'persons';
  const seenFact = new Set();
  for (let i = facts.length - 1; i >= 0; i--) {
    facts[i].args = facts[i].args.map(x => UNIT_CANON[x] ?? x);
    const key = facts[i].predicate + ' ' + facts[i].args.join(' ');
    if (seenFact.has(key)) facts.splice(i, 1); else seenFact.add(key);
  }
  const ruleIds = new Set();
  const goodRules = [];
  for (const r of rules) {
    const atoms = [...(r.when ?? []), r.then];
    const ok = SYMBOL.test(r.id ?? '') && !ruleIds.has(r.id) && (r.when ?? []).length && typeof r.then === 'string' &&
      atoms.every(a => { const t = String(a).replace(/^not /, '').split(/\s+/); return preds.has(t[0]) || CORE_MIN_PREDICATES.has(t[0]); });
    if (!ok) { note('error', r.area, r.id, 'rule rejected: bad id, duplicate id or unknown predicate'); continue; }
    ruleIds.add(r.id); goodRules.push(r);
  }
  return {classes, classAliases, predicates: order, entities: [...entities.values()], facts, rules: goodRules, issues, dropped};
}

const header = (title, lines = []) => ['# ' + title, ...lines.map(l => '# ' + l), ''].join('\n');

export function emitPredicate(p) {
  const out = ['@' + p.id + ' predicate'];
  out.push('  args ' + p.roles.map(([r, t]) => r + ':' + (VALUE_TYPES.has(t) ? t : 'entity')).join(' '));
  for (const [r, t] of p.roles) out.push('  role ' + r + ' ' + t);
  for (const [lang, text] of Object.entries(p.label ?? {})) if (text && lang === 'en') out.push('  label ' + lang + ' ' + q(text));
  if (p.description) out.push('  description ' + q(p.description));
  for (const r of p.reading ?? []) out.push('  reading ' + r);
  if (p.describe_rank) out.push('  describe_rank ' + p.describe_rank);
  if (p.unit) out.push('  unit ' + q(p.unit));
  return out.join('\n') + '\n';
}

export function emitLexemes(p) {
  const out = [];
  const ids = new Set();
  for (const lx of p.lexemes) {
    let id = ('lx_' + p.id + '_' + lx.language + '_' + lx.pos + (lx.frame[0] !== p.roles[0][0] ? '_conv' : '')).slice(0, 60), n = 1, base = id;
    while (ids.has(id)) id = base + '_' + (++n);
    ids.add(id);
    out.push('@' + id + ' lexeme', '  of ' + p.id, '  language ' + lx.language, '  pos ' + lx.pos);
    for (const f of lx.forms) out.push('  form ' + q(f));
    out.push('  frame ' + lx.frame.join(' '));
    for (const [r, c] of lx.restrict) out.push('  restrict ' + r + ' ' + c);
    if (lx.weight !== null) out.push('  weight ' + lx.weight);
    out.push('  source ' + q(lx.source), '');
  }
  return out.join('\n');
}

export function emitEntity(e) {
  const out = ['@' + e.id + ' entity', '  kind ' + e.kind];
  for (const [lang, text] of Object.entries(e.label ?? {})) if (text && lang === 'en') out.push('  label ' + lang + ' ' + q(text));
  const seen = new Set(Object.values(e.label ?? {}));
  for (const [lang, list] of Object.entries(e.alias ?? {})) if (lang === 'en') for (const a of list ?? []) if (a && !seen.has(a)) { seen.add(a); out.push('  alias ' + lang + ' ' + q(a)); }
  return out.join('\n') + '\n';
}

export function emitRule(r) {
  const out = ['@' + r.id + ' rule'];
  for (const w of r.when) out.push('  when ' + w);
  out.push('  then ' + r.then);
  if (r.source) out.push('  source ' + q(r.source));
  return out.join('\n') + '\n';
}

export function render(model) {
  const files = new Map();
  const models = [...new Set(model.predicates.map(p => p.model).concat(model.entities.map(e => e.model)))].filter(Boolean).sort();
  const gen = 'Generated by tools/linking/core-en/build.mjs from the omp authoring batches (models: ' + models.join(', ') + '); reviewed circuits of the base memory core-en.';
  // classes
  let s = header('core-en: classes', [gen, 'core-min declares class, entity, person, organization, place, occupation, property and unit; the other classes are here.']);
  const alias = model.classAliases;
  for (const c of model.classes) {
    if (CORE_MIN_CLASSES.has(c.id)) continue;
    const extra = alias.get(c.id)?.alias ?? {};
    s += emitEntity({id: c.id, kind: 'class', label: {en: c.en}, alias: extra}) + '\n';
  }
  for (const c of model.classes) if (c.is_a) s += '@isa_' + c.id + ' fact\n  holds is_a ' + c.id + ' ' + c.is_a + '\n  source "core-en class hierarchy"\n\n';
  files.set('0001-classes.sop', s);
  let n = 10;
  for (const area of AREAS) {
    const ps = model.predicates.filter(p => p.area === area);
    if (!ps.length) continue;
    let t = header('core-en: ' + area, [gen]);
    for (const p of ps) { if (!p.coreMin) t += emitPredicate(p) + '\n'; }
    for (const p of ps) t += emitLexemes(p) + '\n';
    for (const r of model.rules.filter(r => r.area === area)) t += emitRule(r) + '\n';
    for (const f of model.facts.filter(f => f.area === area)) t += '@fact_' + f.predicate + '_' + String(f.args[0]).replace(/\W/g, '_') + ' fact\n  holds ' + f.predicate + ' ' + f.args.map(a => typeof a === 'number' ? a : a).join(' ') + '\n  source ' + q(f.source ?? 'authored') + '\n\n';
    files.set('00' + String(n++).padStart(2, '0') + '-' + area + '.sop', t);
  }
  for (const kind of ['occupation', 'property', 'unit', 'currency']) {
    const es = model.entities.filter(e => e.kind === kind);
    if (!es.length) continue;
    let t = header('core-en: ' + kind + ' entities', [gen]);
    for (const e of es) t += emitEntity(e) + '\n';
    files.set('01' + String(['occupation', 'property', 'unit', 'currency'].indexOf(kind)).padStart(2, '0') + '-' + kind + '.sop', t);
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mined = JSON.parse(readFileSync(join(ROOT, 'eval/reports/current/core-en/mined.json'), 'utf8'));
  const model = assemble(loadBatches(), {mined});
  const files = render(model);
  const errors = model.issues.filter(i => i.severity === 'error');
  console.log(JSON.stringify({predicates: model.predicates.length, entities: model.entities.length, rules: model.rules.length, facts: model.facts.length, issues: model.issues.length, errors: errors.length, dropped: model.dropped.length}));
  for (const i of model.issues) console.log(i.severity, i.area, i.id, i.message);
  if (!process.argv.includes('--check')) {
    mkdirSync(OUT, {recursive: true});
    for (const f of readdirSync(OUT)) if (/^\d{4}-.*\.sop$/.test(f)) rmSync(join(OUT, f));
    for (const [name, text] of files) writeFileSync(join(OUT, name), text);
    mkdirSync(join(ROOT, 'eval/reports/current/core-en'), {recursive: true});
    writeFileSync(join(ROOT, 'eval/reports/current/core-en/dropped.json'), JSON.stringify(model.dropped, null, 1) + '\n');
    console.log('wrote', [...files.keys()].join(' '));
  }
}
