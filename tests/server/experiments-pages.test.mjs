// The /experiments pages (server/web.mjs, server/history.mjs, server/pages/history.mjs):
// login redirects, 401 for the APIs, the legacy /project redirect, rendering from
// fixture tasks, notes, journal and experiments, and report path-traversal protection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {adminServer, tempDir, withEnv, repoPath} from '../helpers.mjs';
import {appendJournal} from '../../lib/journal.mjs';
import {appendNote} from '../../lib/notes.mjs';
import {resolveReportPath, readReport, listReports, repoLink, loadHistory, entryPage, entries} from '../../server/history.mjs';
import {legacyProjectRedirect, isProtectedPage} from '../../server/web.mjs';
import {renderMarkdown} from '../../server/markdown.mjs';

const PASSWORD = 'correct horse battery';
const htmlGet = (base, route, headers = {}) => fetch(base + route, {headers: {Accept: 'text/html', ...headers}, redirect: 'manual'});

/** A fixture status directory: topics, notes with a supersede chain, tasks, journal and experiments. */
function fixture(t) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'topics.json'), JSON.stringify({format: 'chatsop-topics-v1', topics: [
    {id: 'training-experiments', title: 'Training experiments', scope: 'Runs and results.'},
    {id: 'evaluation', title: 'Evaluation', scope: 'Suites and metrics.'},
  ]}));
  const old = appendNote({ts: '2026-09-29T05:16:00Z', topic: 'training-experiments', kind: 'result', author: 'training-agent', title: 'Fixture Gemma 73.2% (first run)', body: 'parse 93.8% in exp-size', links: ['eval/reports/current/no-such-file.json']}, {dir});
  appendNote({ts: '2026-09-29T05:19:00Z', topic: 'training-experiments', kind: 'correction', author: 'training-agent', title: 'Fixture GGUF turn tokens lost', body: 'The exp-size first run is **invalid**. <script>alert(1)</script>', links: ['https://example.org/x'], supersedes: old.id}, {dir});
  appendNote({ts: '2026-09-28T18:13:00Z', topic: 'training-experiments', kind: 'decision', author: 'owner', title: 'Fixture owner authorizes exp-size', body: 'Explicit approval.', links: []}, {dir});
  appendNote({ts: '2026-09-29T06:00:00Z', topic: 'evaluation', kind: 'observation', author: 'eval-agent', title: 'Fixture dev overstates test', body: 'dev 97.7% vs 78.8%', links: []}, {dir});
  const journal = path.join(dir, 'journal.jsonl');
  appendJournal({ts: '2026-09-28T18:13:13Z', area: 'training', actor: 'owner-via-orchestrator', title: 'Owner authorizes exp-size', detail: 'go', links: [], state: 'decision'}, {file: journal});
  appendJournal({ts: '2026-09-29T01:57:54Z', area: 'training', actor: 'training-agent', title: 'exp-size: model trained', detail: 'dev 92.3%', links: [], state: 'done'}, {file: journal});
  appendJournal({ts: '2026-09-29T02:00:00Z', area: 'data', actor: 'data-agent', title: 'Unrelated data event', detail: '', links: [], state: 'done'}, {file: journal});
  fs.writeFileSync(path.join(dir, 'experiments.json'), JSON.stringify({format: 'chatsop-experiments-v1', experiments: [
    {id: 'exp-size', name: 'Fixture size study', hypothesis: 'Small is enough', preregistration: 'none: fixture', data_version: 'v1', status: 'running', category: 'reference-baseline', registered_at: '2026-09-28T18:40:00Z', results_summary: 'dev 92.3%', results: {dev: {n: 4736, d: 5131}}, deviations: [{id: 1, at: '2026-09-28T20:45Z', what: 'epoch-end selection', effect: 'none'}], conclusions: 'Not adequate.', reports: ['eval/reports/current']},
    {id: 'exp-orphan', name: 'Fixture orphan study', hypothesis: 'h', preregistration: 'none: fixture', data_version: 'v1', status: 'done', category: 'data-study', registered_at: '2026-09-27T10:00:00Z'},
  ]}));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({format: 'chatsop-tasks-v1', phase: {name: 'Fixture phase', since: '2026-09-29T07:00:00Z'}, tasks: [
    {id: 'exp-size', kind: 'experiment', title: 'Fixture size study task', status: 'running', started_at: '2026-09-28T18:13:13Z', summary: 'Fixture summary', topics: ['training-experiments'], experiments: ['exp-size'], match: ['exp-size'], owner: 'The owner **asked** for a size study.', agents: 'Agents ran **a1–a4**.', follow_ups: ['Finish Gemma'], links: ['AGENTS.md']},
    {id: 'older-task', kind: 'task', title: 'Fixture older task', status: 'done', started_at: '2026-09-28T05:00:00Z', summary: 'Older', owner: 'o', agents: 'a'},
  ]}));
  return dir;
}

test('/experiments pages: login redirect for browsers, 401 for APIs, 301 from the former /project paths', async t => {
  const {base, call} = await adminServer(t, {password: PASSWORD});
  for (const route of ['/experiments', '/experiments/topics', '/experiments/topic/evaluation', '/experiments/reports', '/experiments/report?path=x', '/experiments/timeline', '/experiments/questions', '/experiments/formalizer-size-v1']) {
    const page = await htmlGet(base, route);
    assert.equal(page.status, 303, route);
    assert.equal(page.headers.get('location'), '/login?next=' + encodeURIComponent(route), route);
  }
  for (const route of ['/experiments/api/status', '/experiments/api/tasks', '/experiments/api/topics', '/experiments/api/notes', '/experiments/api/report?path=eval/reports/current', '/project/api/status', '/project/api/notes']) {
    const response = await call(route);
    assert.equal(response.status, 401, route);
    assert.equal(response.body.error.code, 'unauthorized');
  }
  for (const [from, to] of [['/project', '/experiments'], ['/project/topic/evaluation', '/experiments/topic/evaluation'], ['/project/report?path=eval%2Freports', '/experiments/report?path=eval%2Freports']]) {
    const moved = await htmlGet(base, from);
    assert.equal(moved.status, 301, from);
    assert.equal(moved.headers.get('location'), to);
  }
  assert.equal(legacyProjectRedirect('/project/api/status'), null, 'APIs are not redirected');
  assert.equal(legacyProjectRedirect('/projects'), null);
  assert.equal(isProtectedPage('/experiments/api/status'), false);
  assert.equal(isProtectedPage('/experiments/anything'), true);
});

test('/experiments renders the index, task, experiment, topic, reports and questions pages from fixtures', async t => {
  const dir = fixture(t);
  const {call, session} = await withEnv('CHATSOP_STATUS_DIR', dir, () => adminServer(t, {password: PASSWORD}));
  const get = route => withEnv('CHATSOP_STATUS_DIR', dir, () => call(route, {cookie: session}));

  const index = await get('/experiments');
  assert.equal(index.status, 200);
  assert.match(index.text, /Experiments &amp; project history/);
  assert.match(index.text, /Fixture phase/);
  assert.match(index.text, /explicit approval per run/, 'the AGENTS.md training rule is quoted');
  // Newest first: the size study (2026-09-28 18:13) before the orphan study (09-27) and the older task (09-28 05:00).
  const order = ['Fixture size study task', 'Fixture older task', 'Fixture orphan study'].map(title => index.text.indexOf(title));
  assert.ok(order.every(position => position > 0) && order[0] < order[1] && order[1] < order[2], String(order));
  assert.match(index.text, /href="\/experiments\/topic\/training-experiments"/);
  assert.match(index.text, /href="\/experiments\/exp-orphan"/, 'an experiment without a task still gets a page');

  const task = await get('/experiments/exp-size');
  assert.equal(task.status, 200);
  const owner = task.text.indexOf('<h2>Owner</h2>'), agents = task.text.indexOf('<h2>Agents / analysis</h2>');
  assert.ok(owner > 0 && agents > owner);
  const ownerSide = task.text.slice(owner, agents), agentSide = task.text.slice(agents);
  assert.match(ownerSide, /The owner <b>asked<\/b>/);
  assert.match(ownerSide, /Owner authorizes exp-size/, 'the owner decision event is on the owner side');
  assert.match(ownerSide, /Fixture owner authorizes exp-size/, 'the owner decision note is on the owner side');
  assert.match(agentSide, /exp-size: model trained/);
  assert.match(agentSide, /Fixture GGUF turn tokens lost/);
  assert.doesNotMatch(task.text, /Unrelated data event/);
  assert.ok(agentSide.indexOf('Fixture GGUF turn tokens lost') < agentSide.indexOf('exp-size: model trained'), 'the agent stack is newest first');
  assert.match(task.text, /Experiment record <code>exp-size<\/code>/);
  assert.match(task.text, /epoch-end selection/);
  assert.doesNotMatch(task.text, /<script>alert/, 'note bodies are escaped');

  const orphan = await get('/experiments/exp-orphan');
  assert.equal(orphan.status, 200);
  assert.match(orphan.text, /Fixture orphan study/);
  assert.equal((await get('/experiments/no-such-entry')).status, 404);

  const topic = await get('/experiments/topic/training-experiments');
  assert.equal(topic.status, 200);
  const titles = ['Fixture GGUF turn tokens lost', 'Fixture Gemma 73.2% (first run)', 'Fixture owner authorizes exp-size'].map(title => topic.text.indexOf(title));
  assert.ok(titles[0] > 0 && titles[0] < titles[1] && titles[1] < titles[2], 'newest first: ' + titles);
  assert.match(topic.text, /Superseded by <a href="\/experiments\/topic\/training-experiments#training-experiments-20260929-051900-/);
  assert.match(topic.text, /Supersedes <a href="\/experiments\/topic\/training-experiments#training-experiments-20260929-051600-/);
  assert.match(topic.text, /data-filter="kind" data-value="correction"/);
  assert.match(topic.text, /data-filter="author" data-value="owner"/);
  assert.match(topic.text, /<code>eval\/reports\/current\/no-such-file\.json<\/code>/, 'a missing report is shown as code, not a broken link');
  assert.equal((await get('/experiments/topic/nope')).status, 404);

  const topics = await get('/experiments/topics');
  assert.match(topics.text, /Runs and results\./);
  const notes = await get('/experiments/api/notes?topic=training-experiments&kind=correction');
  assert.equal(notes.status, 200);
  assert.deepEqual(notes.body.notes.map(item => item.title), ['Fixture GGUF turn tokens lost']);
  const api = await get('/experiments/api/tasks');
  assert.deepEqual(api.body.entries.map(entry => entry.id), ['exp-size', 'older-task', 'exp-orphan']);
  const topicApi = await get('/experiments/api/topics');
  assert.equal(topicApi.body.topics.find(item => item.id === 'training-experiments').count, 3);

  const reports = await get('/experiments/reports');
  assert.equal(reports.status, 200);
  assert.match(reports.text, /eval\/reports\/current/);
  const questions = await get('/experiments/questions');
  assert.equal(questions.status, 200);
  assert.match(questions.text, /Open owner questions/);
  const timeline = await get('/experiments/timeline');
  assert.match(timeline.text, /Timeline &amp; live status/);
});

test('reports: only eval/reports/{current,history} are served, traversal is refused, large files are previewed', async t => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'eval/reports/current/sub/cache-x'), {recursive: true});
  fs.mkdirSync(path.join(root, 'eval/reports/history'), {recursive: true});
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'secret');
  fs.writeFileSync(path.join(root, 'eval/reports/current/a.md'), '# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  fs.writeFileSync(path.join(root, 'eval/reports/current/sub/b.json'), JSON.stringify([{x: 1, y: 'z'}]));
  fs.writeFileSync(path.join(root, 'eval/reports/current/sub/c.bin'), 'x');
  fs.writeFileSync(path.join(root, 'eval/reports/current/big.log'), 'y'.repeat(3 * 1024 * 1024));
  fs.symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'eval/reports/current/escape.md'));
  for (const bad of ['../AGENTS.md', 'eval/reports/current/../../../AGENTS.md', '/etc/passwd', 'eval/reports/current/a.md\0', 'eval\\reports\\current\\a.md', 'AGENTS.md', 'eval/reports/currentx/a.md', 'eval/reports/current/escape.md', 'eval/reports/current/sub/c.bin', ''])
    assert.throws(() => resolveReportPath(root, bad), /Invalid report path|served only from|No such report|Only Markdown|Not a report/, JSON.stringify(bad));
  assert.equal(resolveReportPath(root, 'eval/reports/current/a.md').rel, 'eval/reports/current/a.md');
  assert.equal(readReport(root, 'eval/reports/current/sub/b.json').json[0].y, 'z');
  const big = readReport(root, 'eval/reports/current/big.log');
  assert.equal(big.truncated, true);
  assert.ok(big.text.length < 200 * 1024);
  const listing = listReports(root, 'eval/reports/current/sub');
  assert.deepEqual(Object.fromEntries(listing.files.map(file => [file.name, file.type])), {'b.json': 'json', 'c.bin': null});
  assert.deepEqual(listing.hidden.map(dir => dir.name), ['cache-x'], 'cache directories are not expanded');
  assert.throws(() => listReports(root, 'eval'), /served only from/);
  assert.equal(repoLink('eval/reports/current/a.md', root), '/experiments/report?path=' + encodeURIComponent('eval/reports/current/a.md'));
  assert.equal(repoLink('eval/reports/current/sub', root), '/experiments/reports?dir=' + encodeURIComponent('eval/reports/current/sub'));
  assert.equal(repoLink('eval/reports/current/missing.json', root), null);
  assert.equal(repoLink('docs/specs/DS007-experiment-preregistration.md', repoPath()), '/docs/specsLoader.html?spec=DS007-experiment-preregistration.md');
  const former = 'docs/specs/DS0' + '42-diversity-generator.md'; // a former id, built so the spec-ref check does not flag this test
  assert.equal(repoLink(former, repoPath()), '/docs/specsLoader.html?spec=DS015-diversity-generator.md', 'former ids follow docs/specs/aliases.json');
  assert.equal(repoLink('javascript:alert(1)', root), null);
  assert.equal(repoLink('questions.md', root), '/experiments/questions');

  // Over HTTP, with the repository as root: traversal answers 400 (page and API).
  const {call, session} = await adminServer(t, {password: PASSWORD});
  for (const bad of ['../AGENTS.md', 'eval/reports/current/../../AGENTS.md', '/etc/passwd', 'status/journal.jsonl']) {
    assert.equal((await call('/experiments/report?path=' + encodeURIComponent(bad), {cookie: session})).status, 400, bad);
    assert.equal((await call('/experiments/api/report?path=' + encodeURIComponent(bad), {cookie: session})).status, 400, bad);
  }
  assert.equal((await call('/experiments/reports?dir=' + encodeURIComponent('eval/../status'), {cookie: session})).status, 400);
});

test('the rendered Markdown is escaped and links are resolved safely', () => {
  const html = renderMarkdown('# T\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.org) `a<b`\n\n- one\n  - two\n\n| h |\n| --- |\n| **b** |\n');
  assert.doesNotMatch(html, /<img|href="javascript/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<a href="https:\/\/example\.org" target="_blank" rel="noopener">ok<\/a>/);
  assert.match(html, /<code>a&lt;b<\/code>/);
  assert.match(html, /<ul><li>one<ul><li>two<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<td><b>b<\/b><\/td>/);
});

test('the tracked history renders: every task and experiment has a page with both sides', () => {
  const history = loadHistory({root: repoPath(), dir: repoPath('status')});
  assert.deepEqual(history.errors, {});
  for (const entry of entries(history)) {
    const page = entryPage(history, entry.id);
    assert.ok(page, entry.id);
    assert.ok(page.task || page.records.length, entry.id);
  }
});
