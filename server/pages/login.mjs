/** The single browser sign-in page: it offers the first-run "choose the
 * administrator password" form until a password exists, and the sign-in form
 * afterwards. Both post to `/login`, which uses the unchanged `Auth.setup` and
 * `Auth.login` checks (minimum length, throttling, scrypt verification). */
import {escapeHtml, layout} from './layout.mjs';

/** Only same-origin relative paths are accepted as a post-login destination:
 * a single leading slash, no scheme or authority, no backslash and no control
 * characters. Anything else falls back to `/`, so `/login` cannot become an
 * open redirect. */
export function safeNext(value) {
  if (typeof value !== 'string' || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const parsed = new URL(value, 'http://chatsop.invalid');
    if (parsed.origin !== 'http://chatsop.invalid') return '/';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return '/';
  }
}

export function loginPage({configured, next = '/', error = null}) {
  const target = escapeHtml(safeNext(next));
  const message = error ? `<p class="notice bad" role="alert">${escapeHtml(error)}</p>` : '';
  const form = configured
    ? `<h1>Sign in</h1>
<p class="muted">Enter the administrator password of this MRP-LLM server.</p>${message}
<form method="post" action="/login" class="card">
<input type="hidden" name="next" value="${target}">
<label for="password">Administrator password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus style="width:100%">
<p><button class="primary" type="submit">Sign in</button></p>
</form>`
    : `<h1>Choose the administrator password</h1>
<p class="muted">First run: no administrator password is set yet. It protects the chat, the corpus audit and the admin page, and is stored only as a salted scrypt hash in <code>state/auth.json</code>.</p>${message}
<form method="post" action="/login" class="card">
<input type="hidden" name="next" value="${target}">
<input type="hidden" name="mode" value="setup">
<label for="password">New password (at least 8 characters)</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required autofocus style="width:100%">
<label for="confirm">Repeat the password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required style="width:100%">
<p><button class="primary" type="submit">Set password and sign in</button></p>
</form>`;
  return layout({title: configured ? 'MRP-LLM sign in' : 'MRP-LLM first run', active: 'login', body: `<main class="wrap" style="max-width:520px">${form}<p class="muted">After signing in you continue to <code>${target}</code>.</p></main>`});
}
