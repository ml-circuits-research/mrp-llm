#!/usr/bin/env node
/**
 * Differential check of two independent compilations of the same source passage into knowledge wires.
 *
 *   node skills/sop-wire-authoring/scripts/compare-compilations.mjs A.sop B.sop [--queries Q.sop[,Q2.sop]] [--json]
 *
 * Both files are validated with `sop/knowledge` (authoring mode). The wires are then compared on meaning, not on spelling: ids,
 * `source`, `quote`, `description` and `message` are ignored, variables are renamed by order of appearance, and predicates are
 * compared by name, role/type signature and `closed` flag. Where test queries are given, each is run against both compilations
 * with the js-reference oracle and the status and rows are compared. Disagreements are the result: a wire only one compilation
 * wrote, a different `closed` flag, a different signature, a different answer. Exit status 0 when the compilations agree, 1 when
 * they differ, 2 when a file does not validate. The check finds omissions and divergent readings; it does not decide which one is
 * right, that is the reviewer's job against the source.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse, tokens, validateProgram} from '../../../sop/knowledge/index.mjs';
import {ask, NotExpressibleError} from '../../../reasoning/strategies/js-reference/index.mjs';

const IGNORED = new Set(['source', 'quote', 'description', 'message', 'speaker']);

/** Canonical text of one field value: variables renamed in order of appearance (`names` is shared by the whole wire). */
function canonicalValue(value, names) {
  return tokens(value).map(t => {
    if (!/^\?/.test(t)) return t;
    if (!names.has(t)) names.set(t, '?v' + names.size);
    return names.get(t);
  }).join(' ');
}

/** The meaning-level keys of a program: `type | field lines`, one per wire, plus the predicate signatures. */
export function wireKeys(text) {
  const keys = new Map();
  for (const w of parse(text).wires) {
    const names = new Map();
    const lines = [];
    for (const f of w.fields) {
      if (IGNORED.has(f.key)) continue;
      lines.push(f.key + ' ' + canonicalValue(f.value, names) + f.block.map(b => ' / ' + canonicalValue(b.text, names)).join(''));
    }
    // a predicate is identified by its name; every other wire by its content
    const key = w.type === 'predicate' ? 'predicate ' + w.id : w.type + ' | ' + lines.join(' | ');
    keys.set(key, w.type === 'predicate' ? lines.join(' | ') : w.id);
  }
  return keys;
}

/** Differences between two programs: wires only in one, and predicates declared differently. */
export function compareWires(a, b) {
  const ka = wireKeys(a), kb = wireKeys(b);
  const onlyA = [], onlyB = [], different = [];
  for (const [k, id] of ka) {
    if (!kb.has(k)) onlyA.push({key: k, id});
    else if (k.startsWith('predicate ') && ka.get(k) !== kb.get(k)) different.push({predicate: k.slice(10), a: ka.get(k), b: kb.get(k)});
  }
  for (const [k, id] of kb) if (!ka.has(k)) onlyB.push({key: k, id});
  return {onlyA, onlyB, different};
}

/** Run each query circuit against both knowledge texts and compare status and rows. */
export function compareAnswers(a, b, queries) {
  const out = [];
  for (const q of queries) {
    const run = knowledge => {
      try {
        const r = ask({theory: {knowledge}, query: q.text}, {});
        return {status: r.status, rows: (r.rows ?? []).map(x => JSON.stringify(x)).sort()};
      } catch (e) {
        return {error: e instanceof NotExpressibleError ? 'not_expressible' : String(e.message).split('\n')[0]};
      }
    };
    const ra = run(a), rb = run(b);
    out.push({query: q.name, a: ra, b: rb, agree: JSON.stringify(ra) === JSON.stringify(rb)});
  }
  return out;
}

export function compare(textA, textB, queries = []) {
  const invalid = [];
  for (const [name, text] of [['A', textA], ['B', textB]]) {
    const r = validateProgram([{name, text, role: 'knowledge'}], {authoring: true});
    for (const p of r.problems) if (p.severity !== 'warning') invalid.push(`${name}:${p.line ?? '?'} ${p.code} ${p.message}`);
  }
  if (invalid.length) return {invalid};
  const wires = compareWires(textA, textB), answers = compareAnswers(textA, textB, queries);
  const agree = !wires.onlyA.length && !wires.onlyB.length && !wires.different.length && answers.every(x => x.agree);
  return {invalid, wires, answers, agree};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const qi = args.indexOf('--queries');
  const queryFiles = qi >= 0 ? args[qi + 1].split(',') : [];
  const files = args.filter((x, i) => !x.startsWith('--') && (qi < 0 || i !== qi + 1));
  if (files.length !== 2) { console.error('usage: compare-compilations.mjs A.sop B.sop [--queries Q.sop[,Q2.sop]] [--json]'); process.exit(2); }
  const r = compare(fs.readFileSync(files[0], 'utf8'), fs.readFileSync(files[1], 'utf8'), queryFiles.map(f => ({name: f, text: fs.readFileSync(f, 'utf8')})));
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (r.invalid.length) { console.log(r.invalid.join('\n')); console.log('a compilation does not validate'); }
  else {
    for (const x of r.wires.onlyA) console.log('only in A: ' + x.key);
    for (const x of r.wires.onlyB) console.log('only in B: ' + x.key);
    for (const x of r.wires.different) console.log(`predicate ${x.predicate} differs: A [${x.a}] B [${x.b}]`);
    for (const x of r.answers.filter(y => !y.agree)) console.log(`query ${x.query} differs: A ${JSON.stringify(x.a)} B ${JSON.stringify(x.b)}`);
    console.log(r.agree ? 'AGREE' : 'DIFFER');
  }
  process.exit(r.invalid.length ? 2 : r.agree ? 0 : 1);
}
