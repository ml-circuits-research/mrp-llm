/**
 * Evidence the knowledge browser shows next to vocabulary items (DS022 "Knowledge browser"). Read only, loaded lazily, and absent
 * evidence is reported as absent, never invented:
 *
 *   mined    eval/reports/current/core-en/mined.json: the relation phrases mined from the symbolic_english and neuro_english rows,
 *            with counts and example messages (a regenerable report: `node tools/linking/core-en/mine.mjs`)
 *   dropped  eval/reports/current/core-en/dropped.json: the forms the core-en build dropped, with the cross-review verdict or the lint
 *   wikidata datasets_sources/core-en/wikidata-properties.json: English labels and aliases of the Wikidata properties a lexeme cites
 *   mapping  tools/world-kb/mapping.mjs: the world-v1 mapping table (Wikidata property -> predicate, kind, flip, scope, curated values)
 *            and datasets_sources/world-kb/build-stats.json (facts per predicate of the last build)
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {phraseKey} from '../../sop/text-keys.mjs';
// The world-v1 mapping table is data owned by tools/world-kb; it is loaded dynamically so a checkout without it still serves the browser.
const {MAPPING = [], DERIVED = []} = await import('../../tools/world-kb/mapping.mjs').catch(() => ({}));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
/** Wikidata aliases are inflected ("is a", "was born in"); forms are lemmas ("be a"). */
const lemma = s => String(s).toLowerCase().replace(/^(is|are|was|were)\s+/, 'be ').replace(/^has\s+/, 'have ').trim();

export class Evidence {
  constructor({root = ROOT} = {}) { this.root = root; }

  file(rel) { return path.join(this.root, rel); }

  /** mined phrases by phrase key: {count, rows, roleSets, examples}. */
  get mined() {
    if (this._mined !== undefined) return this._mined;
    const data = readJson(this.file('eval/reports/current/core-en/mined.json'));
    if (!data?.phrases) return (this._mined = null);
    const map = new Map();
    for (const p of data.phrases) {
      const key = phraseKey(p.phrase ?? p.key);
      const prev = map.get(key);
      if (!prev || prev.count < p.count) map.set(key, {phrase: p.phrase, count: p.count, rows: p.rows, roleSets: p.roleSets, examples: [...new Set((p.examples ?? []).map(e => e.message))].slice(0, 2)});
    }
    return (this._mined = {generated: data.generated, rows: data.rows, phrases: map});
  }

  /** forms dropped by the core-en build per predicate: [{form, why}]. */
  get dropped() {
    if (this._dropped !== undefined) return this._dropped;
    const data = readJson(this.file('eval/reports/current/core-en/dropped.json'));
    if (!Array.isArray(data)) return (this._dropped = null);
    const map = new Map();
    for (const d of data) {
      if (/^not English/.test(d.why)) continue;
      const list = map.get(d.id) ?? map.set(d.id, []).get(d.id);
      for (const form of d.forms ?? (d.form ? [d.form] : [])) list.push({form, why: d.why});
    }
    return (this._dropped = map);
  }

  /** English label and aliases of each Wikidata property, as lemma phrase keys. */
  get wikidata() {
    if (this._wikidata !== undefined) return this._wikidata;
    const data = readJson(this.file('datasets_sources/core-en/wikidata-properties.json'));
    if (!data?.properties) return (this._wikidata = null);
    const map = new Map();
    for (const [pid, p] of Object.entries(data.properties)) {
      const names = [p.label?.en, ...(p.aliases?.en ?? [])].filter(Boolean);
      map.set(pid, {label: p.label?.en ?? null, keys: new Set(names.map(n => phraseKey(lemma(n))))});
    }
    return (this._wikidata = map);
  }

  /** The evidence of one form of a lexeme: corpus counts, the Wikidata properties whose label or alias it is, and the lexeme's own source line. */
  form(form, {source = ''} = {}) {
    const key = phraseKey(form);
    const mined = this.mined?.phrases.get(key) ?? null;
    const cited = [...new Set(String(source).match(/\bP\d+\b/g) ?? [])];
    const wikidata = cited.filter(pid => this.wikidata?.get(pid)?.keys.has(key)).map(pid => ({pid, label: this.wikidata.get(pid).label}));
    const quotedCount = new RegExp(`(\\d+) '${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).exec(source);
    return {form, mined: mined ? {count: mined.count, rows: mined.rows, examples: mined.examples} : quotedCount ? {count: Number(quotedCount[1]), rows: null, examples: []} : null,
      wikidata, cites: cited, evidenced: Boolean(mined || quotedCount || wikidata.length)};
  }

  /** Whether the corpus evidence files exist on this checkout (they are regenerable reports). */
  available() { return {mined: Boolean(this.mined), dropped: Boolean(this.dropped), wikidata: Boolean(this.wikidata)}; }

  /** The world-v1 mapping rows of a predicate (several properties may map to one predicate). */
  mapping(predicate) { return MAPPING.filter(m => m.pred === predicate).map(mappingRow).concat(DERIVED.filter(d => d.pred === predicate).map(d => ({pid: d.source, pred: d.pred, kind: 'derived', scope: ['all selected'], args: roles(d.roles), flip: false, note: d.note, curated: false}))); }

  /** The whole mapping table with the facts per predicate of the last build. */
  mappingTable() {
    const stats = readJson(this.file('datasets_sources/world-kb/build-stats.json'));
    const rows = [...MAPPING.map(mappingRow), ...DERIVED.map(d => ({pid: d.source, pred: d.pred, kind: 'derived', scope: ['all selected'], args: roles(d.roles), flip: false, note: d.note, curated: false}))];
    const shared = new Map();
    for (const r of rows) shared.set(r.pred, (shared.get(r.pred) ?? 0) + 1);
    return {rows: rows.map(r => ({...r, facts_built: stats?.by_predicate?.[r.pred] ?? null, merged: shared.get(r.pred) > 1})), build: stats ? {facts: stats.facts, entities: stats.entities, circuits: stats.circuits} : null};
  }
}

const roles = r => r.map(([a, b]) => `${a}:${b}`).join(' ');
const mappingRow = m => ({pid: m.pid, pred: m.pred, kind: m.kind, scope: m.scope, args: roles(m.roles), flip: Boolean(m.flip), note: m.note ?? '', curated: Boolean(m.only), aliases: m.aliases?.en ?? [], weight: m.weight ?? null});
