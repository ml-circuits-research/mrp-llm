#!/usr/bin/env node
/**
 * Coverage of the mined relation mentions by the core-en circuits.
 *
 * Reads the emitted circuits (config/knowledge/core-en/*.sop and core-min) with the knowledge parser, indexes every English
 * lexeme form and predicate label by phrase key, and checks each mined mention of the symbolic_english and neuro_english
 * train and dev rows against it:
 *   phrase    the mention's relation phrase has a form (any frame);
 *   frame     and the mention's role set (without `time`) equals the frame's role set of a lexeme that holds the form;
 *   unique    and exactly one predicate qualifies (otherwise the linker needs restrict, weight or evidence).
 * Writes eval/reports/current/core-en/coverage.json and prints the headline numbers. It does not call the linker; the lexicon
 * round trip of the linker itself is the lint of tools/linking/core-en/lint-roundtrip.mjs once the linker has landed.
 */
import {readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '../../../sop/knowledge/lexical.mjs';
import {phraseKey} from '../../../sop/linking.mjs';
import {relationRows} from './mine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const unq = s => { try { return JSON.parse(s); } catch { return s; } };

export function loadCircuits(dirs) {
  const wires = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sop')).sort()) wires.push(...parse(readFileSync(join(dir, f), 'utf8')).wires);
  }
  return wires;
}

export function lexiconIndex(wires) {
  const forms = new Map(); // key -> [{predicate, frame, via}]
  const add = (key, entry) => { if (!forms.has(key)) forms.set(key, []); const l = forms.get(key); if (!l.some(e => e.predicate === entry.predicate && e.frame === entry.frame)) l.push(entry); };
  const roles = new Map();
  for (const w of wires) {
    if (w.type === 'predicate') {
      const r = w.fields.filter(f => f.key === 'args').flatMap(f => f.value.split(/\s+/).map(x => x.split(':')[0]));
      roles.set(w.id, r);
      for (const f of w.fields.filter(f => f.key === 'label')) {
        const [lang, ...rest] = f.value.split(/\s+/);
        if (lang === 'en') add(phraseKey(unq(rest.join(' '))), {predicate: w.id, frame: r.join(' '), via: 'label'});
      }
    }
  }
  for (const w of wires) {
    if (w.type !== 'lexeme') continue;
    const get = k => w.fields.filter(f => f.key === k).map(f => f.value);
    if (get('language')[0] !== 'en') continue;
    const frame = get('frame')[0];
    for (const f of get('form')) add(phraseKey(unq(f)), {predicate: get('of')[0], frame, via: 'lexeme'});
  }
  return {forms, roles};
}

export function coverage(index, rows) {
  const total = {mentions: 0, phrase: 0, frame: 0, unique: 0};
  const uncovered = new Map(), ambiguous = new Map(), rowsAll = {rows: 0, phrase: 0, frame: 0};
  for (const row of rows) {
    let okPhrase = true, okFrame = true;
    for (const m of row.wires) {
      total.mentions++;
      const cands = index.forms.get(phraseKey(m.relation));
      const R = new Set(m.roles.map(r => r.name).filter(n => n !== 'time'));
      const fit = (cands ?? []).filter(c => { const set = new Set(c.frame.split(' ')); return set.size === R.size && [...set].every(r => R.has(r)); });
      const preds = new Set(fit.map(c => c.predicate));
      if (cands) total.phrase++; else { okPhrase = false; uncovered.set(m.relation, (uncovered.get(m.relation) ?? 0) + 1); }
      if (fit.length) total.frame++; else { okFrame = false; if (cands) uncovered.set(m.relation + '  [roles ' + [...R].sort().join('+') + ']', (uncovered.get(m.relation + '  [roles ' + [...R].sort().join('+') + ']') ?? 0) + 1); }
      if (preds.size === 1) total.unique++;
      else if (preds.size > 1) ambiguous.set(m.relation + ' -> ' + [...preds].sort().join('|'), (ambiguous.get(m.relation + ' -> ' + [...preds].sort().join('|')) ?? 0) + 1);
    }
    rowsAll.rows++; if (okPhrase) rowsAll.phrase++; if (okFrame && okPhrase) rowsAll.frame++;
  }
  const top = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([phrase, count]) => ({phrase, count}));
  const pct = n => Math.round(1000 * n / total.mentions) / 10;
  return {mentions: total.mentions, phrasePct: pct(total.phrase), framePct: pct(total.frame), uniquePct: pct(total.unique), rows: rowsAll.rows,
    rowsPhrasePct: Math.round(1000 * rowsAll.phrase / rowsAll.rows) / 10, rowsFramePct: Math.round(1000 * rowsAll.frame / rowsAll.rows) / 10,
    uncovered: top(uncovered), ambiguous: top(ambiguous)};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wires = loadCircuits([join(ROOT, 'config/knowledge/core-min'), join(ROOT, 'config/knowledge/core-en')]);
  const rep = coverage(lexiconIndex(wires), relationRows());
  mkdirSync(join(ROOT, 'eval/reports/current/core-en'), {recursive: true});
  writeFileSync(join(ROOT, 'eval/reports/current/core-en/coverage.json'), JSON.stringify(rep, null, 1) + '\n');
  console.log(JSON.stringify({mentions: rep.mentions, phrasePct: rep.phrasePct, framePct: rep.framePct, uniquePct: rep.uniquePct, rowsPhrasePct: rep.rowsPhrasePct, rowsFramePct: rep.rowsFramePct}));
}
