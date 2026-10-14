// The knowledge-language examples of the Markdown documentation (DS004 and the other specifications, the skills) are validated
// by `sop/knowledge/`, because the host-circuit vocabulary check (tools/verify-vocabulary.mjs) skips blocks whose info string
// contains `knowledge`. Fences: ```sop knowledge (a knowledge circuit), ```sop knowledge-query (a query circuit, validated with
// the knowledge fence before it and run on the oracle unless the info says `validate`). The HTML help pages are executed by
// tests/docs/wire-help.test.mjs. This file also covers the differential-check script of the skill sop-wire-authoring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {validateProgram} from '../../sop/knowledge/index.mjs';
import {ask, NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';
import {compare, wireKeys} from '../../skills/sop-wire-authoring/scripts/compare-compilations.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', '.git'].includes(entry.name)) walk(file, out); } else if (file.endsWith('.md')) out.push(file);
  }
  return out;
};

function fences(text) {
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```(\S*)\s*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const info = `${open[2]} ${open[3]}`.trim(), body = [], start = i + 1;
    while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
    if (/\bknowledge/.test(info)) out.push({info, line: start, source: body.join('\n') + '\n'});
  }
  return out;
}

test('the knowledge fences of the specifications and skills validate and run', () => {
  const files = [...walk(path.join(ROOT, 'docs/specs')), ...walk(path.join(ROOT, 'skills')), path.join(ROOT, 'README.md')].filter(f => fs.existsSync(f));
  let count = 0;
  for (const file of files) {
    let knowledge = '';
    for (const block of fences(fs.readFileSync(file, 'utf8'))) {
      const label = `${path.relative(ROOT, file)}:${block.line}`;
      count++;
      if (/knowledge-query/.test(block.info)) {
        const r = validateProgram([...(knowledge ? [{name: 'k', text: knowledge, role: 'knowledge'}] : []), {name: label, text: block.source, role: 'query'}]);
        assert.deepEqual(r.problems.filter(p => p.severity !== 'warning').map(p => `${p.code} ${p.message}`), [], `${label} validates`);
        if (/\bvalidate\b/.test(block.info)) assert.throws(() => ask({theory: {knowledge}, query: block.source}, {}), NotExpressibleError, `${label} is a question the oracle declares not_expressible`);
        else assert.ok(ask({theory: {knowledge}, query: block.source}, {}).status, `${label} runs on the oracle`);
      } else {
        const r = validateProgram([{name: label, text: block.source, role: 'knowledge'}]);
        assert.deepEqual(r.problems.filter(p => p.severity !== 'warning').map(p => `${p.code} ${p.message}`), [], `${label} validates`);
        knowledge = block.source;
      }
    }
  }
  assert.ok(count >= 8, `knowledge fences found (${count})`);
});

test('the specifications link every wire of the catalogue to an existing help page', () => {
  const ds004 = fs.readFileSync(path.join(ROOT, 'docs/specs/DS004-sop.md'), 'utf8');
  const linked = [...ds004.matchAll(/\]\(wire_typs\/([a-z_]+)\.html\)/g)].map(m => m[1]);
  assert.ok(linked.length >= 18);
  for (const name of linked) assert.ok(fs.existsSync(path.join(ROOT, 'docs/wire_typs', name + '.html')), `${name}.html exists`);
});

test('the differential check compares two compilations on meaning, not on spelling', () => {
  const a = '@located_in predicate\n  args subject:entity location:entity\n@f1 fact\n  holds located_in paris france\n  source "Atlas"\n@f2 fact\n  holds located_in lyon france\n';
  const sameMeaning = '@located_in predicate\n  args subject:entity location:entity\n@x fact\n  holds located_in lyon france\n@y fact\n  holds located_in paris france\n  quote "Paris is in France"\n';
  const query = '@q query\n  where located_in ?c france\n  select ?c\n';
  assert.equal(compare(a, sameMeaning, [{name: 'q', text: query}]).agree, true);
  const diverging = a.replace('lyon france', 'nice france').replace('args subject:entity location:entity', 'args subject:entity location:entity\n  closed true');
  const r = compare(a, diverging, [{name: 'q', text: query}]);
  assert.equal(r.agree, false);
  assert.equal(r.wires.onlyA.length, 1);
  assert.equal(r.wires.onlyB.length, 1);
  assert.equal(r.wires.different[0].predicate, 'located_in');
  assert.equal(r.answers[0].agree, false);
  // a variable's name is not meaning
  assert.deepEqual([...wireKeys('@p predicate\n  args subject:entity\n@r rule\n  when p ?a\n  then p ?a\n').keys()], [...wireKeys('@p predicate\n  args subject:entity\n@s rule\n  when p ?zz\n  then p ?zz\n').keys()]);
  // a compilation that does not validate is reported, not compared
  assert.ok(compare(a, '@f fact\n  holds located_in paris\n  valid nonsense\n').invalid.length > 0);
});
