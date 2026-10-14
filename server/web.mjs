/** Browser routes of the local server: the home page, the single `/login`
 * flow, `/logout`, and the redirect of unauthenticated browser page loads to
 * `/login?next=…`. Access decisions stay with `Auth` (password hash, throttle,
 * session cookie); API routes keep answering JSON 401/403 in `server/http.mjs`.
 *
 * `createSignedInRoutes` serves the pages and APIs that server/http.mjs
 * dispatches only after authentication: the evaluation browser (`/eval`,
 * `/eval/guide`, `/eval/api/*`) and the project history under `/experiments`
 * (index, one page per task or experiment, topics, reports, timeline,
 * questions, `/experiments/api/*`). The former `/project` pages redirect to
 * `/experiments`; `/project/api/*` stays as an API alias. `/assets/sop-code.mjs`
 * is the public SOP highlighter module used by the documentation pages.
 */
import {sessionCookie, readCookie} from './auth.mjs';
import {sendHtml} from './pages/layout.mjs';
import {homePage} from './pages/home.mjs';
import {loginPage, safeNext} from './pages/login.mjs';
import {sopCodeModule} from './pages/sop-code.mjs';
import {projectPage} from './pages/project.mjs';
import {indexPage, entryPageHtml, topicsPageHtml, topicPageHtml, reportsPageHtml, reportPageHtml, questionsPageHtml, notFoundHtml} from './pages/history.mjs';
import {BASE, loadHistory, entryPage, topicPage, listReports, readReport, questions} from './history.mjs';
import {createProjectRouter, gates as computeGates, dataPipeline} from './project.mjs';
import {readExperiments} from '../lib/journal.mjs';

/** Pages that a browser should reach through the login page when signed out. */
export const PROTECTED_PAGES = new Set(['/chat', '/models', '/review', '/experiments', '/admin']);
/** True for a signed-in browser page: the fixed pages and every `/experiments/…` page except its API. */
export const isProtectedPage = pathname => PROTECTED_PAGES.has(pathname) || (pathname.startsWith(BASE + '/') && !pathname.startsWith(BASE + '/api/'));

/** The former `/project` pages moved to `/experiments`: `/project` → `/experiments`, `/project/topic/x` → `/experiments/topic/x`. APIs are not redirected. */
export function legacyProjectRedirect(url) {
  const parsed = new URL(url, 'http://localhost');
  if (parsed.pathname !== '/project' && !(parsed.pathname.startsWith('/project/') && !parsed.pathname.startsWith('/project/api/'))) return null;
  return BASE + parsed.pathname.slice('/project'.length) + parsed.search;
}
const CLEAR_COOKIE = 'chatsop_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';

/** A browser page load asks for HTML; API clients (fetch, curl, SDKs) do not. */
export const wantsHtml = req => /\btext\/html\b/.test(String(req.headers.accept ?? ''));

/** Refuses cross-site form posts: a present Origin must match the Host header,
 * and a browser-reported cross-site fetch is rejected. */
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readForm(req, limit = 8192) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) return null;
  }
  return new URLSearchParams(raw);
}

const redirect = (res, location, headers = {}) => {
  res.writeHead(303, {Location: location, 'Cache-Control': 'no-store', ...headers});
  res.end();
};

/**
 * Handles browser routes before API authentication. Returns true when the
 * request was answered. `auth` may be null for bearer-only embedded servers,
 * in which case only the home page is served.
 */
export async function handleWeb(req, res, pathname, {auth, readiness}) {
  if (req.method === 'GET' && pathname === '/assets/sop-code.mjs') {
    res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'});
    res.end(sopCodeModule);
    return true;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const moved = legacyProjectRedirect(req.url);
    if (moved) {
      res.writeHead(301, {Location: moved, 'Cache-Control': 'no-store'});
      res.end();
      return true;
    }
  }
  const session = auth ? auth.session(readCookie(req.headers.cookie, 'chatsop_session')) : null;
  if (req.method === 'GET' && pathname === '/') {
    const state = await readiness();
    sendHtml(res, 200, homePage({signedIn: Boolean(session), configured: Boolean(auth?.configured), passwordStore: Boolean(auth), ready: state.ready, codingAgent: state.formalizer ?? null}));
    return true;
  }
  if (!auth) return false;
  const query = new URL(req.url, 'http://localhost').searchParams;
  if (req.method === 'GET' && pathname === '/login') {
    const next = safeNext(query.get('next') ?? '/');
    if (session) redirect(res, next);
    else sendHtml(res, 200, loginPage({configured: auth.configured, next}));
    return true;
  }
  if (req.method === 'POST' && pathname === '/login') {
    if (!sameOrigin(req)) {
      sendHtml(res, 403, loginPage({configured: auth.configured, error: 'Cross-site sign-in refused. Open the sign-in page on this server and try again.'}));
      return true;
    }
    const form = await readForm(req);
    if (!form) {
      sendHtml(res, 413, loginPage({configured: auth.configured, error: 'The form was too large.'}));
      return true;
    }
    const next = safeNext(form.get('next') ?? '/');
    const password = form.get('password') ?? '';
    const fail = (status, error) => sendHtml(res, status, loginPage({configured: auth.configured, next, error}));
    if (!auth.configured) {
      if (password !== (form.get('confirm') ?? '')) return fail(400, 'The two passwords do not match.'), true;
      let token;
      try {
        token = auth.setup(password);
      } catch (error) {
        return fail(400, /at least \d+ characters/.test(error.message) ? 'The password is too short: use at least 8 characters.' : error.message), true;
      }
      redirect(res, next, {'Set-Cookie': sessionCookie(token)});
      return true;
    }
    if (form.get('mode') === 'setup') return fail(409, 'An administrator password is already set. Sign in with it.'), true;
    let token;
    try {
      token = auth.login(password);
    } catch (error) {
      if (error.code === 'too_many_attempts') return fail(429, 'Too many failed attempts. Wait a minute and try again.'), true;
      throw error;
    }
    if (!token) return fail(401, 'Wrong password. Try again.'), true;
    redirect(res, next, {'Set-Cookie': sessionCookie(token)});
    return true;
  }
  if (req.method === 'POST' && pathname === '/logout') {
    if (!sameOrigin(req)) {
      sendHtml(res, 403, loginPage({configured: auth.configured, error: 'Cross-site sign-out refused.'}));
      return true;
    }
    auth.logout(readCookie(req.headers.cookie, 'chatsop_session'));
    redirect(res, '/login', {'Set-Cookie': CLEAR_COOKIE});
    return true;
  }
  if (req.method === 'GET' && isProtectedPage(pathname) && !session && !req.headers.authorization && wantsHtml(req)) {
    redirect(res, '/login?next=' + encodeURIComponent(safeNext(req.url)));
    return true;
  }
  return false;
}

/**
 * Pages and APIs for an authenticated user (session cookie or bearer token);
 * server/http.mjs calls `handle` only after authentication.
 * `send(status, body)` answers JSON. Returns true when the request was handled.
 */
export function createSignedInRoutes({root} = {}) {
  const project = createProjectRouter(root ? {root} : {});
  const handle = async (req, res, pathname, query, send, {signedIn = true} = {}) => {
    if (pathname.startsWith(BASE + '/api/') || pathname.startsWith('/project/api/')) return project.handle(req, res, pathname, query, send);
    if (req.method === 'GET' && (pathname === BASE || pathname.startsWith(BASE + '/'))) return experimentsPage(res, pathname, query, {root, signedIn}), true;
    return false;
  };
  return {handle};
}

/** Serves one `/experiments` page (server/pages/history.mjs); unknown pages answer 404 inside the section. */
function experimentsPage(res, pathname, query, {root, signedIn}) {
  const repo = root ?? undefined;
  const history = loadHistory(repo ? {root: repo} : {});
  const site = history.root;
  const missing = what => sendHtml(res, 404, notFoundHtml({what, signedIn}));
  const rest = pathname.slice(BASE.length).replace(/^\//, '');
  if (!rest) {
    let registry = [];
    try {
      registry = readExperiments().experiments;
    } catch {
      registry = [];
    }
    const gateList = computeGates(site, {pipeline: dataPipeline(site), experiments: registry});
    const rule = gateList.find(gate => gate.id === 'owner-approval')?.evidence ?? null;
    return sendHtml(res, 200, indexPage({history, gates: gateList, rule, questions: questions(site), signedIn}));
  }
  if (rest === 'timeline') return sendHtml(res, 200, projectPage({signedIn}));
  if (rest === 'topics') return sendHtml(res, 200, topicsPageHtml({history, signedIn}));
  if (rest === 'questions') return sendHtml(res, 200, questionsPageHtml({questions: questions(site), root: site, signedIn}));
  if (rest === 'reports' || rest === 'report') {
    try {
      if (rest === 'reports') return sendHtml(res, 200, reportsPageHtml({listing: listReports(site, query.dir || null), signedIn}));
      if (!query.path) return missing('Give ?path=eval/reports/… to view a report.');
      return sendHtml(res, 200, reportPageHtml({report: readReport(site, query.path), root: site, signedIn}));
    } catch (error) {
      return sendHtml(res, error.status ?? 400, notFoundHtml({what: error.message, signedIn}));
    }
  }
  const topic = /^topic\/([a-z0-9-]+)$/.exec(rest);
  if (topic) {
    const data = topicPage(history, topic[1]);
    return data ? sendHtml(res, 200, topicPageHtml({data, root: site, signedIn})) : missing(`No topic ${topic[1]}.`);
  }
  if (/^[A-Za-z0-9_.-]+$/.test(rest)) {
    const data = entryPage(history, rest);
    return data ? sendHtml(res, 200, entryPageHtml({data, root: site, signedIn})) : missing(`No task or experiment ${rest}.`);
  }
  return missing(`No page ${pathname}.`);
}
