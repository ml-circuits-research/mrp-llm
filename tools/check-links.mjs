#!/usr/bin/env node
/** Link checker for the served site: the server pages, the documentation under
 * `/docs/`, the specifications opened through `specsLoader.html?spec=…` and
 * the wire-help anchors that the SOP code renderer links to.
 *
 *   node tools/check-links.mjs                       # starts a scratch server (temporary state, ephemeral port)
 *   node tools/check-links.mjs --base http://127.0.0.1:9471 --cookie 'chatsop_session=…'
 *
 * Rules:
 * - Crawls from the home page, every server page and the documentation entry;
 *   follows same-origin `href`/`src` attributes of HTML pages (not form
 *   actions, not `/logout`), and the Markdown links of every specification.
 * - Every followed URL must answer 200. A `#fragment` must name an `id` or
 *   `name` in the target HTML (the generated heading ids of specifications
 *   are not checked; the spec file itself must exist).
 * - `data-include` partials are resolved against the page and `data-link-base`,
 *   as `docs/partials-loader.mjs` does in the browser.
 * - Every type and field of the SOP contract (`server/pages/sop-code.mjs`)
 *   must have `/docs/wire_typs/<type>.html` with `id="field-<field>"`, because
 *   SOP code on the server pages links there.
 * Exit status 1 when anything is broken. The scratch server never touches the
 * repository state: repository, auth file and audit ledger live in a temp dir.
 */
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const START_PAGES = ['/', '/chat', '/experiments', '/experiments/topics', '/experiments/reports', '/experiments/timeline', '/experiments/questions', '/admin', '/docs/', '/docs/wire_types.html', '/docs/specsLoader.html?spec=matrix.md'];
const SKIP = new Set(['/logout', '/login']);
// The report browser serves regenerable evaluation data (eval/reports/**), thousands of files: links into it are checked, but its pages
// are not crawled further (only the index /experiments/reports itself is followed), so the crawl covers the site, not the data.
const isReportData = url => url.pathname === '/experiments/report' || (url.pathname === '/experiments/reports' && url.search !== '') || url.pathname.startsWith('/experiments/reports/');
const ATTR = /\s(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;

const decodeEntities = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Anchors (`id` and `name`) of an HTML text. */
export function anchorsOf(html) {
  return new Set([...html.matchAll(/\s(?:id|name)\s*=\s*"([^"]+)"/g)].map(m => decodeEntities(m[1])));
}

/** Same-origin link targets of an HTML page, resolved against `pageUrl`. Script and style bodies are skipped. */
export function linksOf(html, pageUrl) {
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, m => m.replace(/>[\s\S]*<\/script>/i, '></script>'))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<form\b[^>]*>/gi, '<form>');
  const out = [];
  for (const m of body.matchAll(ATTR)) {
    const raw = decodeEntities(m[2] ?? m[3] ?? '').trim();
    if (!raw || /^(mailto:|javascript:|data:|tel:|blob:)/i.test(raw) || raw.includes('${')) continue;
    out.push(raw);
  }
  for (const m of body.matchAll(/data-include\s*=\s*"([^"]+)"(?:[^>]*data-link-base\s*=\s*"([^"]*)")?/g)) out.push({include: m[1], linkBase: m[2] ?? ''});
  return out;
}

/** Markdown links of a specification, outside code spans and fenced blocks. */
export function markdownLinks(md) {
  const text = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map(m => m[2]);
}

/**
 * Crawls the site at `base` with an optional session `cookie`.
 * Returns `{visited, urls, broken: [{from, href, problem}]}`; `urls` are the crawled paths.
 */
export async function checkSite({base, cookie = '', start = START_PAGES, contract = null, maxPages = 5000} = {}) {
  const origin = new URL(base).origin;
  const cache = new Map();
  const broken = [];
  const fetchText = async url => {
    const key = url.split('#')[0];
    if (!cache.has(key)) cache.set(key, (async () => {
      const response = await fetch(key, {headers: {Accept: 'text/html,*/*', ...(cookie ? {Cookie: cookie} : {})}, redirect: 'manual'});
      const type = response.headers.get('content-type') ?? '';
      const text = /text\/|json|javascript|markdown/.test(type) ? await response.text() : (await response.arrayBuffer(), '');
      return {status: response.status, type, text, location: response.headers.get('location')};
    })());
    return cache.get(key);
  };
  const queue = [];
  const seen = new Set();
  const enqueue = (url, from) => {
    const key = url.split('#')[0];
    if (!seen.has(key) && seen.size < maxPages) { seen.add(key); queue.push({url: key, from}); }
  };
  const check = async (from, href, resolved, {follow = true} = {}) => {
    const url = new URL(resolved);
    if (url.origin !== origin) return;
    if (SKIP.has(url.pathname)) return;
    let result = await fetchText(url.href);
    if (result.status >= 300 && result.status < 400 && result.location) result = await fetchText(new URL(result.location, url).href);
    if (result.status !== 200) return broken.push({from, href, problem: `HTTP ${result.status}`});
    const spec = url.pathname.endsWith('/specsLoader.html') ? url.searchParams.get('spec') : null;
    if (spec) {
      const file = new URL('specs/' + spec, url);
      const md = await fetchText(file.href);
      if (md.status !== 200) return broken.push({from, href, problem: `specification ${spec} not found (HTTP ${md.status})`});
      if (follow) enqueue(file.href, from);
      return;
    }
    if (url.hash && /html/.test(result.type)) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!anchorsOf(result.text).has(id)) broken.push({from, href, problem: `missing anchor #${id}`});
    }
    if (follow && !isReportData(url) && (/html/.test(result.type) || url.pathname.endsWith('.md'))) enqueue(url.href, from);
  };

  for (const route of start) enqueue(new URL(route, base).href, '(start)');
  while (queue.length) {
    const {url, from} = queue.shift();
    const page = await fetchText(url);
    if (page.status >= 300 && page.status < 400 && page.location) { enqueue(new URL(page.location, url).href, url); continue; }
    if (page.status !== 200) { broken.push({from, href: url, problem: `HTTP ${page.status}`}); continue; }
    const pagePath = new URL(url).pathname;
    if (pagePath.endsWith('.md')) {
      const loader = new URL('/docs/specsLoader.html', base).href;
      for (const href of markdownLinks(page.text)) {
        if (/^[a-z]+:/i.test(href) && !href.startsWith(origin)) continue;
        await check(pagePath, href, new URL(href, loader).href);
      }
      continue;
    }
    if (!/html/.test(page.type)) continue;
    const ownAnchors = anchorsOf(page.text);
    for (const link of linksOf(page.text, url)) {
      if (typeof link === 'object') {
        const partialUrl = new URL(link.include, url);
        const partial = await fetchText(partialUrl.href);
        if (partial.status !== 200) { broken.push({from: pagePath, href: link.include, problem: `include HTTP ${partial.status}`}); continue; }
        const linkBase = new URL(link.linkBase || './', url);
        for (const inner of linksOf(partial.text, linkBase.href)) if (typeof inner === 'string') {
          if (inner.startsWith('#')) continue;
          await check(pagePath + ' (partial ' + link.include + ')', inner, new URL(inner, linkBase).href);
        }
        continue;
      }
      if (link.startsWith('#')) {
        const id = decodeURIComponent(link.slice(1));
        if (id && !ownAnchors.has(id)) broken.push({from: pagePath, href: link, problem: `missing anchor #${id}`});
        continue;
      }
      await check(pagePath, link, new URL(link, url).href);
    }
  }

  if (contract) {
    for (const [type, fields] of Object.entries(contract)) {
      const href = `/docs/wire_typs/${encodeURIComponent(type)}.html`;
      const page = await fetchText(new URL(href, base).href);
      if (page.status !== 200) { broken.push({from: 'SOP code renderer', href, problem: `HTTP ${page.status}`}); continue; }
      const anchors = anchorsOf(page.text);
      for (const field of fields) if (!anchors.has('field-' + field)) broken.push({from: 'SOP code renderer', href: `${href}#field-${field}`, problem: `missing anchor #field-${field}`});
    }
  }
  return {visited: seen.size, urls: [...seen].map(url => { const u = new URL(url); return u.pathname + u.search; }), broken};
}

/** Starts a server with scratch state (temporary repository, auth file and audit ledger), signs in, returns `{base, cookie, close}`. */
export async function scratchServer({password = 'link-checker-password'} = {}) {
  const [{createServer}, {Auth}, {Repository}, {Lexicon}] = await Promise.all([
    import('../server/http.mjs'), import('../server/auth.mjs'), import('../memory/repository.mjs'), import('../sop/lexicon.mjs')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsop-links-'));
  const repo = new Repository(path.join(dir, 'state'));
  repo.init('demo');
  const auth = new Auth({file: path.join(dir, 'state/auth.json')});
  const previous = process.env.CHATSOP_AUDIT_LEDGER;
  process.env.CHATSOP_AUDIT_LEDGER = path.join(dir, 'ledger');
  let server;
  try {
    // No coding agent: the chat page renders and the API answers 503 parse_unavailable (the crawl never starts omp).
    const offline = {settings: {models: [], backend: {kind: 'none'}}, availability: async () => ({available: false, reason: 'scratch server', models: [], skipped: []}), parse: async () => { throw Object.assign(new Error('scratch server'), {code: 'parse_unavailable', status: 503}); }, stats: () => ({}), clearCache: () => {}};
    server = createServer({config: {}, repo, lexicon: demoLexicon(), auth, queryParser: offline});
  } finally {
    if (previous === undefined) delete process.env.CHATSOP_AUDIT_LEDGER; else process.env.CHATSOP_AUDIT_LEDGER = previous;
  }
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/admin/setup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password})});
  if (response.status !== 200) throw Error(`scratch sign-in failed: HTTP ${response.status}`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  const close = () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => { fs.rmSync(dir, {recursive: true, force: true}); resolve(); }); });
  return {base, cookie, close};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const {SOP_CONTRACT} = await import('../server/pages/sop-code.mjs');
  const scratch = option('--base') ? null : await scratchServer();
  const base = option('--base') ?? scratch.base;
  const cookie = option('--cookie') ?? scratch?.cookie ?? '';
  try {
    const {visited, broken} = await checkSite({base, cookie, contract: SOP_CONTRACT});
    for (const b of broken) console.log(`BROKEN ${b.from} -> ${b.href}: ${b.problem}`);
    console.log(`${visited} pages and files crawled, ${broken.length} broken link(s)`);
    process.exitCode = broken.length ? 1 : 0;
  } finally {
    await scratch?.close();
  }
}
