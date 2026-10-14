import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkSpecRefs} from '../../tools/check-spec-refs.mjs';

// Identifiers are assembled at run time so this file itself never cites a specification id.
const id = n => 'DS' + String(n).padStart(3, '0');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-refs-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const spec = name => `---\ntitle: ${name}\nsummary: s\n---\n\nbody\n`;
const matrix = names => '# Matrix\n\n| Name | Description |\n| --- | --- |\n' + names.map(n => `| [${n}](specsLoader.html?spec=${n}.md) | d |\n`).join('');
const aliases = JSON.stringify({ids: {[id(0)]: {to: id(0)}, [id(1)]: {to: id(1)}, [id(7)]: {archived: 'probably_obsolete/specs/' + id(7) + '-old.md'}}});

test('a gap-free set with resolving references passes', () => {
  const a = id(0) + '-alpha', b = id(1) + '-beta';
  const dir = fixture({
    [`docs/specs/${a}.md`]: spec(a), [`docs/specs/${b}.md`]: spec(b), 'docs/specs/matrix.md': matrix([a, b]),
    'docs/specs/aliases.json': aliases, 'README.md': `See ${id(1)} and docs/specs/${b}.md.\n`,
    [`probably_obsolete/specs/${id(7)}-old.md`]: `Archived ${id(7)} cites ${id(0)}.\n`,
    'status/journal.jsonl': `{"note":"${id(7)}"}\n`,
  });
  assert.deepEqual(checkSpecRefs(dir).violations, []);
});

test('gaps, stale matrix rows, dangling ids, archive paths and unknown frozen ids are reported', () => {
  const a = id(0) + '-alpha', c = id(2) + '-gamma';
  const dir = fixture({
    [`docs/specs/${a}.md`]: spec(a), [`docs/specs/${c}.md`]: spec(id(2) + '-wrong'), 'docs/specs/matrix.md': matrix([a]),
    'docs/specs/aliases.json': aliases,
    'README.md': `Former ${id(7)}; renamed ${id(0)}-beta.md; lost ${'probably_obsolete'}/specs/missing.md; archived docs/specs/${id(7)}-old.md\n`,
    'status/journal.jsonl': `{"note":"${id(9)}"}\n`,
  });
  const rules = checkSpecRefs(dir).violations.map(v => v.rule).sort();
  assert.deepEqual([...new Set(rules)], [1, 2, 3, 4, 5, 6]);
});

test('the repository specifications and their references are consistent', () => {
  const {violations} = checkSpecRefs();
  assert.deepEqual(violations, []);
});
