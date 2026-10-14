/** Shared shell for the server-rendered browser pages (home, login, chat,
 * audit, eval, experiments, admin): one stylesheet, the shared top menu of
 * server/pages/site-menu.mjs (the same menu as the documentation site) and
 * HTML escaping. The pages only present the existing session-cookie
 * authentication; they never decide access themselves. */
import {renderSiteHeader, SITE_MENU_SCRIPT, SITE_MENU_STYLE} from './site-menu.mjs';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]);

export const STYLE = `
:root{color-scheme:light dark;--bg:#f7f8fa;--panel:#fff;--text:#1b2733;--muted:#5b6b7a;--line:#d5dde4;--accent:#1f6f9f;--accent-text:#fff;--ok:#1d7f4e;--bad:#b3261e;--soft:#eef3f7}
@media (prefers-color-scheme:dark){:root{--bg:#12171c;--panel:#1a2128;--text:#e3e9ee;--muted:#9aa8b4;--line:#2d3842;--accent:#4aa3d8;--accent-text:#0b1620;--ok:#5cc38d;--bad:#f08a80;--soft:#222c35}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
code,pre,textarea.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:960px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:1.45rem;margin:.2em 0 .6em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:0 0 14px}
.tile{display:block;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;text-decoration:none;color:var(--text)}
.tile:hover,.tile:focus-visible{border-color:var(--accent)}
.tile b{display:block;font-size:1.15rem;color:var(--accent);margin-bottom:4px}
.tile span{color:var(--muted);font-size:14px}
button,.button{font:inherit;padding:7px 14px;border-radius:7px;border:1px solid var(--line);background:var(--soft);color:var(--text);cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button:disabled{opacity:.55;cursor:wait}
input,select,textarea{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--text);max-width:100%}
label{display:block;margin:10px 0 4px;font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}.muted{color:var(--muted)}
.notice{border-left:4px solid var(--accent);background:var(--soft);padding:10px 12px;border-radius:6px;margin:0 0 14px}
.notice.bad{border-left-color:var(--bad);color:var(--text)}
pre{background:var(--soft);padding:10px;border-radius:6px;overflow:auto;max-height:360px;margin:6px 0}
ul.plain{list-style:none;padding:0;margin:0}ul.plain li{padding:4px 0}
@media (max-width:560px){.wrap{padding:14px 10px 30px}.card{padding:12px}}
`;

/** Wraps page content with the shared top menu. `signedIn` switches the
 * account slot between "Sign in" and a POST logout button. */
export function layout({title, active = '', signedIn = false, body, script = '', style = '', next: nextPath = null}) {
  const account = signedIn ? 'logout' : active === 'login' ? 'none' : 'signin';
  const next = nextPath ?? (active === 'home' || !active ? '/' : '/' + active);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}${SITE_MENU_STYLE}${style}</style></head>
<body>${renderSiteHeader({docsBase: '/docs/', active, account, next})}
${body}
<script>${SITE_MENU_SCRIPT}</script>${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

/** Sends a server-rendered HTML page that must never be cached. */
export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
  res.end(html);
}
