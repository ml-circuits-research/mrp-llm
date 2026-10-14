/** The one top menu shared by the server pages and the documentation site.
 *
 * `SITE_MENU` is the single source of truth. `server/pages/layout.mjs` renders
 * it on every server page, and `docs/partials/header.html` is generated from it
 * by `node tools/site-menu.mjs --write` (a test keeps the two identical). The
 * styling lives in one stylesheet, `docs/assets/site-menu.css`, which the docs
 * import and the server layout inlines.
 *
 * Server entries (`href`) use absolute paths, also inside a dropdown (the
 * Experiments menu). Documentation entries (`doc`) are relative to the docs root: the server layout prefixes them with `/docs/`, while the docs
 * header keeps them relative so `docs/partials-loader.mjs` can rebase them for
 * nested pages (`data-link-base`).
 */
import fs from 'node:fs';

export const SITE_MENU = Object.freeze([
  {key: 'home', label: 'Home', href: '/'},
  {key: 'chat', label: 'Chat', href: '/chat'},
  {key: 'models', label: 'Symbolic Models', href: '/models'},
  {key: 'review', label: 'Knowledge', href: '/review'},
  {key: 'experiments', label: 'Experiments', items: [
    {key: 'experiments-index', label: 'Index: tasks & experiments', href: '/experiments'},
    {key: 'experiments-topics', label: 'Topics', href: '/experiments/topics'},
    {key: 'experiments-reports', label: 'Reports', href: '/experiments/reports'},
    {key: 'experiments-timeline', label: 'Timeline & live status', href: '/experiments/timeline'},
    {key: 'experiments-questions', label: 'Open questions', href: '/experiments/questions'},
  ]},
  {key: 'admin', label: 'Admin', href: '/admin'},
  {key: 'docs', label: 'Docs', items: [
    {key: 'overview', label: 'Overview', doc: 'index.html'},
    {key: 'runtime', label: 'Runtime', doc: 'runtime.html'},
    {key: 'architecture', label: 'Architecture', doc: 'architecture.html'},
    {key: 'input-language', label: 'Input language', doc: 'input-language.html'},
    {key: 'api', label: 'API', doc: 'api.html'},
    {key: 'wiki', label: 'Wiki', doc: 'wiki.html'},
    {key: 'specs', label: 'Specifications', doc: 'specsLoader.html?spec=matrix.md'},
    {key: 'wire', label: 'Wire help', doc: 'wire_types.html'},
    {key: 'model-guide', label: 'How circuits are written', doc: 'wire_types.html#model-guide'},
    {key: 'questions', label: 'Question types', doc: 'wire_types.html#question-types'},
  ]},
]);

/** The shared menu stylesheet, read once from the docs asset. */
export const SITE_MENU_STYLE = fs.readFileSync(new URL('../../docs/assets/site-menu.css', import.meta.url), 'utf8');

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]);

/**
 * The header markup. `docsBase` prefixes documentation links ('' in the docs
 * partial, '/docs/' on server pages). `account` is the right-hand slot:
 * `logout` (a POST form), `signin` (a link carrying `next`) or `none`.
 */
export function renderSiteHeader({docsBase = '/docs/', active = '', account = 'logout', next = '/'} = {}) {
  const current = key => (key === active ? ' aria-current="page"' : '');
  const entries = SITE_MENU.map(entry => {
    if (!entry.items) return `<a href="${escape(entry.href)}"${current(entry.key)}>${escape(entry.label)}</a>`;
    const open = entry.items.some(item => item.key === active);
    const links = entry.items.map(item => `<a href="${escape(item.href ?? docsBase + item.doc)}"${current(item.key)}>${escape(item.label)}</a>`).join('');
    return `<details class="menu${open ? ' active' : ''}" data-menu="${escape(entry.key)}"><summary>${escape(entry.label)}</summary><div class="menu__panel">${links}</div></details>`;
  }).join('');
  const slot = account === 'logout'
    ? '<form method="post" action="/logout"><button type="submit">Logout</button></form>'
    : account === 'signin' ? `<a href="/login?next=${encodeURIComponent(next)}">Sign in</a>` : '';
  return `<header class="site-header"><a class="site-heading" href="/">MRP-LLM</a><nav class="site-nav" aria-label="MRP-LLM">${entries}</nav><div class="site-account">${slot}</div></header>`;
}

/** The documentation partial, exactly as `docs/partials/header.html` must contain it. */
export const docsHeaderHtml = () => renderSiteHeader({docsBase: '', account: 'logout'}) + '\n';

/** Browser behaviour of the dropdowns (Experiments, Docs): one open at a time, closes on outside click or Escape. */
export const SITE_MENU_SCRIPT = `(()=>{const menus=()=>[...document.querySelectorAll('.site-header details.menu')];
document.addEventListener('toggle',e=>{if(e.target.matches?.('.site-header details.menu')&&e.target.open)for(const m of menus())if(m!==e.target)m.open=false;},true);
document.addEventListener('pointerdown',e=>{for(const m of menus())if(m.open&&!m.contains(e.target))m.open=false;});
document.addEventListener('keydown',e=>{if(e.key==='Escape')for(const m of menus())if(m.open){m.open=false;m.querySelector('summary').focus();}});})();`;
