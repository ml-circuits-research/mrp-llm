// Link check of the served site (tools/check-links.mjs): a signed-in crawl of
// the server pages, the documentation, every specification opened through
// specsLoader.html, and the wire-help anchors that SOP code links to.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {checkSite, scratchServer, linksOf, markdownLinks, anchorsOf} from '../../tools/check-links.mjs';
import {SOP_CONTRACT} from '../../server/pages/sop-code.mjs';

test('link extraction: attributes, partials, Markdown outside code, anchors', () => {
  const html = '<a href="a.html#x">a</a><img src="i.png"><form action="/logout"></form><script src="s.mjs">const x = "<a href=\\"no.html\\">";</script><div data-include="partials/header.html" data-link-base="../"></div><a href="mailto:x@y">m</a>';
  assert.deepEqual(linksOf(html, 'http://h/docs/'), ['a.html#x', 'i.png', 's.mjs', {include: 'partials/header.html', linkBase: '../'}]);
  assert.deepEqual(markdownLinks('[matrix](specsLoader.html?spec=matrix.md) `[no](x.md)`\n```\n[no](y.md)\n```'), ['specsLoader.html?spec=matrix.md']);
  assert.ok(anchorsOf('<h2 id="field-where">x</h2><a name="top"></a>').has('top'));
});

test('the served site has no broken links, specifications or wire-help field anchors', async () => {
  const server = await scratchServer();
  try {
    const {visited, urls, broken} = await checkSite({base: server.base, cookie: server.cookie, contract: SOP_CONTRACT});
    assert.ok(visited > 50, `crawled ${visited} pages`);
    assert.deepEqual(broken.map(b => `${b.from} -> ${b.href}: ${b.problem}`), []);
    // The menus reach every specification and every wire help page.
    const reached = new Set(urls);
    for (const file of fs.readdirSync(new URL('../../docs/specs/', import.meta.url)).filter(name => name.endsWith('.md')))
      assert.ok(reached.has('/docs/specs/' + file), `docs/specs/${file} is reachable from the site`);
    for (const file of fs.readdirSync(new URL('../../docs/wire_typs/', import.meta.url)).filter(name => name.endsWith('.html')))
      assert.ok(reached.has('/docs/wire_typs/' + file), `docs/wire_typs/${file} is reachable from the site`);
    // Repository Markdown linked from the docs is served read-only, to signed-in users only, from an allowlist.
    const skill = await fetch(server.base + '/skills/README.md', {headers: {Cookie: server.cookie}});
    assert.equal(skill.status, 200);
    assert.match(skill.headers.get('content-type'), /^text\/plain/);
    assert.equal((await fetch(server.base + '/skills/README.md')).status, 401);
    assert.equal((await fetch(server.base + '/config/runtime.json', {headers: {Cookie: server.cookie}})).status, 404);
  } finally {
    await server.close();
  }
});
