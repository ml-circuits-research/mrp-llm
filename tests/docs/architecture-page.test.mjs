// docs/architecture.html is generated from the source tree (tools/docs/build-architecture.mjs). This test keeps it honest: the claims the
// generator makes about the code still hold, and every file:line citation of the committed page still points at a line matching the
// pattern it was generated from. When it fails, fix the code or the page's statement and run `node tools/docs/build-architecture.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildArchitecture} from '../../tools/docs/build-architecture.mjs';
import {repoPath} from '../helpers.mjs';

const unescape = text => text.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

test('the claims and patterns of the architecture generator hold in the working tree', () => {
  const {problems, reachable, total} = buildArchitecture();
  assert.deepEqual(problems, []);
  assert.ok(reachable > 100 && reachable < total, 'the product import scan found the product modules');
});

test('every file:line citation of docs/architecture.html points at a line that still matches its pattern', () => {
  const html = fs.readFileSync(repoPath('docs/architecture.html'), 'utf8');
  const cites = [...html.matchAll(/<code class="cite" data-re="([^"]*)">([^<]+):(\d+)<\/code>/g)];
  assert.ok(cites.length >= 30, `the page has citations (${cites.length})`);
  const stale = [];
  for (const [, encoded, file, line] of cites) {
    const path = repoPath(unescape(file));
    const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').split('\n')[Number(line) - 1] : undefined;
    if (text === undefined || !new RegExp(unescape(encoded)).test(text)) stale.push(`${file}:${line} /${unescape(encoded)}/`);
  }
  assert.deepEqual(stale, [], 'stale citations; run node tools/docs/build-architecture.mjs');
});
