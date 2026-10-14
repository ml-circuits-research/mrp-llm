/** The `/experiments` pages (DS009): the index of every major task and
 * experiment, one page per task or experiment with the owner's side and the
 * agents' side kept apart, the topic note stacks, the read-only report viewer
 * and the open owner questions. Pages are rendered on the server from the data
 * of server/history.mjs; the only browser code is the kind/author filter of a
 * topic page. Every list is newest first. The journal timeline and the live
 * gates stay on `/experiments/timeline` (server/pages/project.mjs).
 */
import {layout, escapeHtml as esc} from './layout.mjs';
import {renderMarkdown} from '../markdown.mjs';
import {BASE, repoLink, entries, topicSummaries, currentStatus, preregistrationRecord} from '../history.mjs';

export const HISTORY_STYLE = `
.hist{max-width:1180px}
.hist h2{font-size:1.12rem;margin:0 0 8px}
.hist h3{font-size:1rem;margin:12px 0 6px}
.crumbs{font-size:13px;color:var(--muted);margin:0 0 6px}
.crumbs a{text-decoration:none}
table.t{border-collapse:collapse;width:100%;font-size:14px}
table.t td,table.t th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
table.t th{color:var(--muted);font-weight:600;font-size:13px}
.tablewrap{overflow-x:auto;max-width:100%}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.meta{font-size:12px;color:var(--muted)}
.tag{font-size:11px;padding:0 6px;border-radius:8px;border:1px solid var(--line);background:var(--soft);margin-right:4px;white-space:nowrap}
.tag.k-decision,.tag.owner{border-color:#8250df;color:#8250df}
.tag.k-result,.tag.s-done{border-color:var(--ok);color:var(--ok)}
.tag.k-correction,.tag.s-blocked,.tag.s-abandoned{border-color:var(--bad);color:var(--bad)}
.tag.k-suggestion,.tag.k-plan,.tag.s-running,.tag.s-open{border-color:var(--accent);color:var(--accent)}
.sides{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
@media (max-width:900px){.sides{grid-template-columns:1fr}}
.side-owner{border-top:4px solid #8250df}
.side-agents{border-top:4px solid var(--accent)}
.md{font-size:14.5px;overflow-wrap:anywhere}
.md h1,.md h2,.md h3,.md h4{font-size:1rem;margin:12px 0 4px}
.md p{margin:6px 0}
.md ul,.md ol{margin:4px 0;padding-left:22px}
.md blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--line);color:var(--muted)}
.md table{font-size:13px}
.md pre{max-height:none}
ol.stack{list-style:none;margin:0;padding:0}
ol.stack>li{border-left:3px solid var(--line);padding:4px 0 10px 12px;margin:0 0 4px 4px;position:relative}
ol.stack>li::before{content:'';position:absolute;left:-7px;top:9px;width:11px;height:11px;border-radius:50%;background:var(--line)}
ol.stack>li.owner::before{background:#8250df}ol.stack>li.note::before{background:var(--accent)}
ol.stack>li.superseded{opacity:.62}
article.note{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:0 0 10px}
article.note.superseded{opacity:.66;border-style:dashed}
article.note h3{margin:2px 0 4px}
.chain{font-size:13px;margin:4px 0}
.chain.old{color:var(--bad)}
.filters{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px;align-items:center}
.filters button{padding:2px 10px;font-size:13px;border-radius:12px}
.filters button.on{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.detailtext{white-space:pre-wrap;font-size:13.5px;margin:3px 0}
.links a,.links code{font-size:12px;margin-right:8px;overflow-wrap:anywhere}
pre.json{max-height:70vh}
.banner{border:2px solid var(--bad);background:color-mix(in srgb,var(--bad) 8%,var(--panel));border-radius:10px;padding:10px 14px;margin:0 0 14px}
.two{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:14px}
@media (max-width:900px){.two{grid-template-columns:1fr}}
`;

const when = ts => (ts ? esc(String(ts).replace('T', ' ').replace(/(:\d{2})(\.\d+)?Z$/, '$1Z').replace(/:\d{2}Z$/, 'Z')) : '');
const clip = (value, max) => (String(value ?? '').length > max ? String(value).slice(0, max - 1) + '…' : String(value ?? ''));

/** A link to a repository path or URL, or the path as code when the site has no page for it. */
const linkOf = (target, root) => {
  const href = repoLink(target, root);
  return href ? `<a href="${esc(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${esc(clip(target, 110))}</a>` : `<code>${esc(target)}</code>`;
};
const linksBlock = (links, root) => (links?.length ? `<div class="links">${links.map(link => linkOf(link, root)).join(' ')}</div>` : '');
const md = (text, root) => `<div class="md">${renderMarkdown(text, {resolveLink: target => repoLink(target, root) ?? (/^https?:\/\//.test(target) ? target : null)})}</div>`;
const noteHref = note => `${BASE}/topic/${encodeURIComponent(note.topic)}#${encodeURIComponent(note.id)}`;
const page = ({title, active, signedIn, body, script = '', next}) => layout({title: `${title} · MRP-LLM`, active, signedIn, body: `<main class="wrap hist">${body}</main>`, style: HISTORY_STYLE, script, next});
const crumbs = (...items) => `<nav class="crumbs"><a href="${BASE}">Experiments</a>${items.map(([label, href]) => ' › ' + (href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label))).join('')}</nav>`;
const errorsBlock = errors => (Object.keys(errors ?? {}).length ? `<div class="notice bad">${Object.entries(errors).map(([key, message]) => `<div><b>${esc(key)}</b>: ${esc(message)}</div>`).join('')}</div>` : '');

/** One journal event as a stack item. */
function eventItem(event, root) {
  const owner = event.state === 'decision' || /^owner/.test(event.actor);
  return `<li class="${owner ? 'owner' : ''}"><div class="meta">${when(event.ts)} · journal #${event.index} · ${esc(event.actor)}</div>` +
    `<div><span class="tag">${esc(event.area)}</span><span class="tag ${owner ? 'owner' : 's-' + esc(event.state)}">${esc(event.state)}</span><b>${esc(event.title)}</b></div>` +
    (event.detail ? `<div class="detailtext">${esc(event.detail)}</div>` : '') + linksBlock(event.links, root) + '</li>';
}

/** One note as a stack item (on task pages) with a link to its topic page. */
function noteItem(note, root, superseded) {
  const later = superseded.get(note.id) ?? [];
  return `<li class="note${later.length ? ' superseded' : ''}"><div class="meta">${when(note.ts)} · note in <a href="${esc(noteHref(note))}">${esc(note.topic)}</a> · ${esc(note.author)}</div>` +
    `<div><span class="tag k-${esc(note.kind)}">${esc(note.kind)}</span><b>${esc(note.title)}</b></div>` +
    (later.length ? `<div class="chain old">superseded by ${later.map(id => `<code>${esc(id)}</code>`).join(', ')}</div>` : '') +
    (note.supersedes ? `<div class="chain">supersedes <code>${esc(note.supersedes)}</code></div>` : '') +
    `<details><summary class="meta">read the note</summary>${md(note.body, root)}${linksBlock(note.links, root)}</details></li>`;
}

/** Notes and events merged into one newest-first stack. */
function stack(notes, events, root, superseded, empty) {
  const items = [...notes.map(note => ({ts: note.ts, html: noteItem(note, root, superseded)})), ...events.map(event => ({ts: event.ts, html: eventItem(event, root)}))]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return items.length ? `<ol class="stack">${items.map(item => item.html).join('')}</ol>` : `<p class="muted">${esc(empty)}</p>`;
}

/** `/experiments`: current status, every task and experiment, the topics and the other history pages. */
export function indexPage({history, gates = [], rule = null, questions = null, signedIn = true}) {
  const status = currentStatus(history);
  const list = entries(history);
  const topics = topicSummaries(history);
  const open = gates.filter(gate => gate.open && !gate.prohibited).length, checks = gates.filter(gate => !gate.prohibited).length;
  const phase = history.phase;
  const header = `<section class="card"><h2>Current status</h2>
<div class="two"><div>
<p><b>Phase:</b> ${phase ? `${esc(phase.name)} <span class="meta">(since ${when(phase.since)})</span>${phase.detail ? md(phase.detail, history.root) : ''}` : '<span class="muted">not recorded (status/tasks.json "phase")</span>'}</p>
<p><b>Training authorization.</b> ${rule ? `AGENTS.md rule 3: <i>${esc(rule)}</i>` : 'AGENTS.md rule 3 not found.'}</p>
${status.trainingDecisions.length ? `<div class="meta">Latest owner decisions about training in the journal (newest first):</div><ul>${status.trainingDecisions.map(event => `<li>${when(event.ts)} · ${esc(event.actor)}: <b>${esc(event.title)}</b> <span class="meta">${esc(clip(event.detail, 260))}</span></li>`).join('')}</ul>` : ''}
<p class="meta">Computed checks: ${open} of ${checks} open (details and evidence on the <a href="${BASE}/timeline">timeline &amp; live status</a> page). An open check is an observation, never an approval.</p>
</div><div>
<p><b>In progress or waiting:</b></p>${status.running.length ? `<ul>${status.running.map(item => `<li><a href="${BASE}/${esc(encodeURIComponent(item.id))}">${esc(item.title)}</a> <span class="tag s-${esc(item.status)}">${esc(item.status)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing is recorded as running.</p>'}
<p><b>Open owner questions</b> (<a href="${BASE}/questions">questions.md</a>):</p>${questions?.open?.length ? `<ul>${questions.open.map(title => `<li>${esc(title)}</li>`).join('')}</ul>` : '<p class="muted">None open.</p>'}
<p><b>Latest journal activity</b> (12 h before the newest event):</p><ul>${status.recent.map(event => `<li class="meta">${when(event.ts)} · ${esc(event.actor)} · ${esc(event.title)}</li>`).join('') || '<li class="muted">none</li>'}</ul>
</div></div></section>`;
  const rows = list.map(entry => `<tr><td class="meta" style="white-space:nowrap">${when(entry.started_at).slice(0, 16)}</td><td><span class="tag">${esc(entry.kind)}</span>${entry.category && entry.category !== 'preregistered' ? `<span class="tag">${esc(entry.category)}</span>` : ''}</td><td><span class="tag s-${esc(entry.status)}">${esc(entry.status)}</span></td>` +
    `<td><a href="${BASE}/${esc(encodeURIComponent(entry.id))}"><b>${esc(entry.title)}</b></a>${entry.parent ? ` <span class="meta">part of <a href="${BASE}/${esc(encodeURIComponent(entry.parent))}">${esc(entry.parent)}</a></span>` : ''}<div class="meta">${esc(clip(entry.summary, 320))}</div></td></tr>`).join('');
  const topicRows = topics.map(topic => `<tr><td><a href="${BASE}/topic/${esc(encodeURIComponent(topic.id))}"><b>${esc(topic.title)}</b></a><div class="meta"><code>${esc(topic.id)}</code></div></td><td class="num">${topic.count}</td>` +
    `<td>${topic.latest ? `<span class="meta">${when(topic.latest.ts).slice(0, 16)}</span> <span class="tag k-${esc(topic.latest.kind)}">${esc(topic.latest.kind)}</span><a href="${esc(noteHref(topic.latest))}">${esc(clip(topic.latest.title, 120))}</a>` : '<span class="muted">no notes yet</span>'}</td></tr>`).join('');
  const body = `<h1>Experiments &amp; project history</h1>
<p class="muted">A living, accumulating record: every major task and experiment has its own page, and the topic notes behind them are append-only (corrections supersede, nothing is deleted). Newest first everywhere. Agents add notes with <code>node tools/notes.mjs add</code> and journal events with <code>node tools/journal.mjs add</code>.</p>
${errorsBlock(history.errors)}${header}
<section class="card"><h2>Tasks and experiments — newest first</h2><div class="tablewrap"><table class="t"><thead><tr><th>started</th><th>kind</th><th>status</th><th>task or experiment</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No tasks recorded.</td></tr>'}</tbody></table></div>
<p class="meta">Task records: <code>status/tasks.json</code>; experiment records: <code>status/experiments.json</code> (DS007).</p></section>
<section class="card" id="topics"><h2>Topics</h2><div class="tablewrap"><table class="t"><thead><tr><th>topic</th><th class="num">notes</th><th>latest entry</th></tr></thead><tbody>${topicRows}</tbody></table></div></section>
<section class="card"><h2>More</h2><ul class="plain"><li><a href="${BASE}/topics">All topics with their scope</a></li><li><a href="${BASE}/reports">Reports</a> (eval/reports/current and history, read-only)</li><li><a href="${BASE}/timeline">Timeline &amp; live status</a> (journal, gates, data pipeline)</li><li><a href="${BASE}/questions">Open owner questions</a></li></ul></section>`;
  return page({title: 'Experiments', active: 'experiments-index', signedIn, body, next: BASE});
}

/** Field table of one experiment record (DS007 "Experiments"). */
function experimentBlock(entry, root) {
  const short = hash => (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? `<code title="${esc(hash)}">${esc(hash.slice(0, 12))}…</code>` : esc(hash ?? ''));
  const text = value => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  const list = (items, fn) => (Array.isArray(items) && items.length ? `<ul>${items.map(item => `<li>${fn(item)}</li>`).join('')}</ul>` : '');
  const prereg = preregistrationRecord(entry, root);
  const fields = [
    ['category', esc(entry.category ?? 'preregistered') + (entry.kind ? `<div class="meta">${esc(entry.kind)}</div>` : '')],
    ['status', `<span class="tag s-${esc(entry.status)}">${esc(entry.status)}</span> ${esc(entry.registered_at ?? entry.date ?? '')}${entry.owner ? ` · owner ${esc(entry.owner)}` : ''}`],
    ['hypothesis', esc(entry.hypothesis)],
    ['what was done', esc(entry.done ?? entry.method ?? '')],
    ['preregistration', esc(entry.preregistration)],
    ['data version', esc(entry.data_version)],
    ['datasets', list(entry.datasets, d => (typeof d === 'string' ? esc(d) : `<b>${esc(d.name ?? '')}</b> ${d.path ? linkOf(d.path, root) : ''}${d.sha256 ? ' sha256 ' + short(d.sha256) : ''}${d.rows ? ' · ' + esc(d.rows) + ' rows' : ''}${d.role ? ' · ' + esc(d.role) : ''}`))],
    ['models', list(entry.models, m => (typeof m === 'string' ? esc(m) : `<b>${esc(m.name ?? '')}</b> ${esc([m.identity, m.version, m.quantization, m.runtime, m.status].filter(Boolean).join(' · '))}`)) || (entry.model ? esc(text(entry.model)) : '')],
    ['metrics', list(entry.metrics, m => esc(text(m)))],
    ['results', (entry.results_summary ? `<p>${esc(entry.results_summary)}</p>` : '') + (entry.results ? `<details><summary class="meta">machine-readable results</summary>${jsonView(entry.results, root, 0)}</details>` : entry.results_summary ? '' : '<span class="muted">none yet</span>')],
    ['deviations', list(entry.deviations, d => (typeof d === 'string' ? esc(d) : `<b>${esc(d.id ?? '')}</b> ${esc(d.at ?? '')} — ${esc(d.what ?? '')}${d.why ? ` <span class="meta">Why: ${esc(d.why)}</span>` : ''}${d.effect ? ` <span class="meta">Effect: ${esc(d.effect)}</span>` : ''}`))],
    ['conclusions', esc(text(entry.conclusions)) || '<span class="muted">none yet</span>'],
    ['reports', list(entry.reports ?? entry.links, link => linkOf(link, root))],
  ].filter(([, value]) => value);
  return `<section class="card" id="record-${esc(entry.id)}"><h2>Experiment record <code>${esc(entry.id)}</code> — ${esc(entry.name ?? '')}</h2>
<div class="tablewrap"><table class="t"><tbody>${fields.map(([name, value]) => `<tr><th style="width:11em">${esc(name)}</th><td>${value}</td></tr>`).join('')}</tbody></table></div>
${prereg ? `<details${prereg.json ? '' : ' open'}><summary><b>Preregistration record</b> <code>${esc(prereg.path)}</code></summary>${prereg.json ? jsonView(prereg.json, root, 0) : `<p class="bad">${esc(prereg.missing ? 'missing' : prereg.error)}</p>`}</details>` : ''}</section>`;
}

/** `/experiments/<id>`: one task or experiment, with the owner's side and the agents' side apart. */
export function entryPageHtml({data, root, signedIn = true}) {
  const {task, records, parent} = data;
  const title = task?.title ?? records[0]?.name ?? records[0]?.id;
  const id = task?.id ?? records[0].id;
  const head = `${crumbs([title])}<h1>${esc(title)}</h1>
<p>${task ? `<span class="tag">${esc(task.kind)}</span><span class="tag s-${esc(task.status)}">${esc(task.status)}</span><span class="meta">started ${when(task.started_at)}${task.updated_at ? ' · updated ' + when(task.updated_at) : ''}</span>` : `<span class="tag">experiment record</span><span class="tag s-${esc(records[0].status)}">${esc(records[0].status)}</span>`}
${parent ? ` <span class="meta">part of <a href="${BASE}/${esc(encodeURIComponent(parent.id))}">${esc(parent.title)}</a></span>` : ''}</p>
${task ? `<div class="notice">${esc(task.summary)}</div>` : ''}${task?.topics?.length ? `<p class="meta">Topics: ${task.topics.map(topic => `<a href="${BASE}/topic/${esc(encodeURIComponent(topic))}">${esc(topic)}</a>`).join(', ')}</p>` : ''}`;
  const sides = `<div class="sides">
<section class="card side-owner"><h2>Owner</h2><p class="meta">What the owner asked, why, and the owner's decisions and corrections.</p>${task ? md(task.owner, root) : '<p class="muted">No task record; the owner-side journal decisions and notes that mention this experiment follow.</p>'}
<h3>Owner decisions and notes — newest first</h3>${stack(data.owner.notes, data.owner.events, root, data.supersededBy, 'No owner decision in the journal or notes mentions this entry.')}</section>
<section class="card side-agents"><h2>Agents / analysis</h2><p class="meta">What was analysed, tried and run (including failed attempts), what was obtained, the conclusions and open follow-ups.</p>${task ? md(task.agents, root) : (records[0].results_summary ? `<p>${esc(records[0].results_summary)}</p>` : '')}
${task?.follow_ups?.length ? `<h3>Open follow-ups</h3><ul>${task.follow_ups.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
${task?.links?.length ? `<h3>Evidence</h3>${linksBlock(task.links, root)}` : ''}
<h3>Agent notes and journal events — newest first</h3>${stack(data.agents.notes, data.agents.events, root, data.supersededBy, 'No agent note or journal event mentions this entry.')}</section></div>`;
  const body = head + sides + records.map(record => experimentBlock(record, root)).join('');
  return page({title, active: 'experiments-index', signedIn, body, next: `${BASE}/${encodeURIComponent(id)}`});
}

/** `/experiments/topics`: every topic with its scope. */
export function topicsPageHtml({history, signedIn = true}) {
  const cards = topicSummaries(history).map(topic => `<section class="card"><h2><a href="${BASE}/topic/${esc(encodeURIComponent(topic.id))}">${esc(topic.title)}</a> <span class="meta"><code>${esc(topic.id)}</code> · ${topic.count} notes</span></h2><p>${esc(topic.scope)}</p>
<p class="meta">${Object.entries(topic.kinds).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `<span class="tag k-${esc(kind)}">${esc(kind)} ${count}</span>`).join('')}${topic.latest ? ` latest ${when(topic.latest.ts).slice(0, 16)}: <a href="${esc(noteHref(topic.latest))}">${esc(clip(topic.latest.title, 120))}</a>` : ''}</p></section>`).join('');
  return page({title: 'Topics', active: 'experiments-topics', signedIn, body: `${crumbs(['Topics'])}<h1>Topics</h1><p class="muted">Each topic accumulates notes: decisions, suggestions, analyses, observations, experiments, results, plans, questions and corrections. The registry is <code>status/topics.json</code>; the notes are <code>status/notes/&lt;topic&gt;.jsonl</code>.</p>${errorsBlock(history.errors)}${cards}`, next: `${BASE}/topics`});
}

/** Browser filter of a topic page: kind and author buttons, initial state from ?kind=&author=. */
function topicFilter() {
  const params = new URLSearchParams(location.search);
  const state = {kind: params.get('kind') || '', author: params.get('author') || ''};
  const apply = () => {
    let shown = 0;
    for (const note of document.querySelectorAll('article.note')) {
      const visible = (!state.kind || note.dataset.kind === state.kind) && (!state.author || note.dataset.author === state.author);
      note.hidden = !visible;
      if (visible) shown++;
    }
    for (const button of document.querySelectorAll('.filters button')) button.classList.toggle('on', state[button.dataset.filter] === button.dataset.value);
    document.getElementById('shown').textContent = shown + ' shown';
    const query = new URLSearchParams(Object.entries(state).filter(([, value]) => value));
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query : '') + location.hash);
  };
  document.addEventListener('click', event => {
    const button = event.target.closest('.filters button');
    if (!button) return;
    state[button.dataset.filter] = button.dataset.value;
    apply();
  });
  apply();
}

/** `/experiments/topic/<id>`: the topic's full stack, newest first, with supersede chains. */
export function topicPageHtml({data, root, signedIn = true}) {
  const {topic, notes, byId, supersededBy: supers} = data;
  const filter = (name, values) => `<div class="filters"><span class="meta">${esc(name)}:</span><button type="button" data-filter="${esc(name)}" data-value="">all</button>${values.map(value => `<button type="button" data-filter="${esc(name)}" data-value="${esc(value)}">${esc(value)}</button>`).join('')}</div>`;
  const articles = notes.map(note => {
    const later = (supers.get(note.id) ?? []).map(id => byId.get(id)).filter(Boolean);
    const earlier = note.supersedes ? byId.get(note.supersedes) : null;
    return `<article class="note${later.length ? ' superseded' : ''}" id="${esc(note.id)}" data-kind="${esc(note.kind)}" data-author="${esc(note.author)}">
<div class="meta">${when(note.ts)} · ${esc(note.author)} · <a href="#${esc(note.id)}"><code>${esc(note.id)}</code></a></div>
<h3><span class="tag k-${esc(note.kind)}">${esc(note.kind)}</span>${esc(note.title)}</h3>
${later.map(other => `<div class="chain old">Superseded by <a href="${esc(noteHref(other))}">${esc(other.title)}</a> (${when(other.ts).slice(0, 16)}). Kept for the record.</div>`).join('')}
${note.supersedes ? `<div class="chain">Supersedes ${earlier ? `<a href="${esc(noteHref(earlier))}">${esc(earlier.title)}</a> (${when(earlier.ts).slice(0, 16)})` : `<code>${esc(note.supersedes)}</code>`}.</div>` : ''}
${md(note.body, root)}${linksBlock(note.links, root)}</article>`;
  }).join('');
  const body = `${crumbs(['Topics', `${BASE}/topics`], [topic.title])}<h1>${esc(topic.title)}</h1><p>${esc(topic.scope)}</p>
${data.tasks.length ? `<p class="meta">Tasks and experiments in this topic: ${data.tasks.map(task => `<a href="${BASE}/${esc(encodeURIComponent(task.id))}">${esc(task.title)}</a>`).join(' · ')}</p>` : ''}
<section class="card"><h2>History — newest first <span class="meta" id="shown">${notes.length} shown</span></h2>${filter('kind', data.kinds)}${filter('author', data.authors)}
<p class="meta">Notes are append-only. A superseded note stays visible, dimmed, with a link to the note that replaces it.</p></section>
${articles || '<p class="muted">No notes yet. Add one with <code>node tools/notes.mjs add --topic ' + esc(topic.id) + ' …</code>.</p>'}`;
  return page({title: topic.title, active: 'experiments-topics', signedIn, body, script: `(${topicFilter})();`, next: `${BASE}/topic/${encodeURIComponent(topic.id)}`});
}

const size = bytes => (bytes >= 1 << 20 ? (bytes / (1 << 20)).toFixed(1) + ' MB' : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B');

/** `/experiments/reports[?dir=…]`: a newest-first directory listing of the report roots. */
export function reportsPageHtml({listing, signedIn = true}) {
  const trail = [];
  if (listing.dir) {
    const parts = listing.dir.split('/');
    for (let i = 3; i <= parts.length; i++) trail.push([i === 3 ? parts.slice(0, 3).join('/') : parts[i - 1], i === parts.length ? null : `${BASE}/reports?dir=${encodeURIComponent(parts.slice(0, i).join('/'))}`]);
  }
  const dirs = listing.dirs.map(dir => `<tr><td class="meta">${when(dir.mtime).slice(0, 16)}</td><td>dir <a href="${BASE}/reports?dir=${esc(encodeURIComponent(dir.path))}">${esc(dir.name)}/</a>${dir.historical ? ' <span class="tag">historical</span>' : ''}</td><td class="num">${dir.entries} entries</td></tr>`).join('');
  const files = listing.files.map(file => `<tr><td class="meta">${when(file.mtime).slice(0, 16)}</td><td>${file.type ? `<a href="${BASE}/report?path=${esc(encodeURIComponent(file.path))}">${esc(file.name)}</a>` : `<code>${esc(file.name)}</code> <span class="meta">(not viewable here)</span>`}</td><td class="num">${size(file.size)}</td></tr>`).join('');
  const hidden = listing.hidden.length ? `<p class="meta">Not expanded (per-call caches and test leftovers): ${listing.hidden.map(dir => `<code>${esc(dir.name)}/</code> (${dir.entries})`).join(', ')}.</p>` : '';
  const body = `${crumbs(['Reports', listing.dir ? `${BASE}/reports` : null], ...trail)}<h1>Reports${listing.dir ? `: <code>${esc(listing.dir)}</code>` : ''}</h1>
<p class="muted">Read-only view of <code>eval/reports/current/</code> (regenerable observations) and <code>eval/reports/history/</code> (archived numbers: never a current run). Newest first. Markdown is rendered, JSON is pretty-printed or tabulated, logs and JSONL are shown as text; files over 2 MB show their beginning only.</p>
${listing.historical ? '<div class="banner"><b>Historical.</b> These are archived observations, not current results.</div>' : ''}
<section class="card"><div class="tablewrap"><table class="t"><thead><tr><th>modified</th><th>name</th><th class="num">size</th></tr></thead><tbody>${listing.parent ? `<tr><td></td><td>↑ <a href="${BASE}/reports?dir=${esc(encodeURIComponent(listing.parent))}">..</a></td><td></td></tr>` : listing.dir ? `<tr><td></td><td>↑ <a href="${BASE}/reports">all reports</a></td><td></td></tr>` : ''}${dirs}${files}</tbody></table></div>${hidden}</section>`;
  return page({title: 'Reports', active: 'experiments-reports', signedIn, body, next: `${BASE}/reports`});
}

const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const scalar = value => (value === null ? '<span class="muted">null</span>' : typeof value === 'number' ? `<span class="num">${esc(value)}</span>` : esc(value));

/** JSON as tables where it is simple (flat objects, arrays of flat records), else pretty-printed. */
export function jsonView(value, root, depth = 0) {
  if (isScalar(value)) return scalar(value);
  const pretty = () => `<pre class="json">${esc(JSON.stringify(value, null, 2))}</pre>`;
  if (depth > 2 || JSON.stringify(value).length > 400000) return pretty();
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="muted">[]</span>';
    if (value.every(isScalar)) return value.length <= 40 ? esc(value.map(item => (item === null ? 'null' : String(item))).join(', ')) : pretty();
    if (value.length <= 400 && value.every(item => item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).every(isScalar))) {
      const columns = [...new Set(value.flatMap(item => Object.keys(item)))];
      if (columns.length <= 14) return `<div class="tablewrap"><table class="t"><thead><tr>${columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${value.map(item => `<tr>${columns.map(column => `<td>${item[column] === undefined ? '' : scalar(item[column])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return value.length <= 60 ? `<ol>${value.map(item => `<li>${jsonView(item, root, depth + 1)}</li>`).join('')}</ol>` : pretty();
  }
  const keys = Object.keys(value);
  if (keys.length > 200) return pretty();
  return `<div class="tablewrap"><table class="t"><tbody>${keys.map(key => `<tr><th style="width:14em">${esc(key)}</th><td>${jsonView(value[key], root, depth + 1)}</td></tr>`).join('')}</tbody></table></div>`;
}

/** `/experiments/report?path=…`: one report, rendered read-only. */
export function reportPageHtml({report, root, signedIn = true}) {
  const dir = report.path.split('/').slice(0, -1).join('/');
  const content = report.truncated
    ? `<div class="notice">This file is ${size(report.size)}; only its first ${size(Buffer.byteLength(report.text))} are shown.</div><pre class="json">${esc(report.text)}</pre>`
    : report.type === 'markdown' ? md(report.text, root)
      : report.type === 'json' && report.json !== undefined ? `${jsonView(report.json, root, 0)}<details><summary class="meta">raw JSON</summary><pre class="json">${esc(JSON.stringify(report.json, null, 2))}</pre></details>`
        : `<pre class="json">${esc(report.text)}</pre>`;
  const body = `${crumbs(['Reports', `${BASE}/reports`], [dir, `${BASE}/reports?dir=${encodeURIComponent(dir)}`], [report.path.split('/').at(-1)])}<h1><code>${esc(report.path)}</code></h1>
<p class="meta">${esc(report.type)} · ${size(report.size)} · modified ${when(report.mtime)} · read-only</p>
${report.historical ? '<div class="banner"><b>Historical.</b> An archived observation, not a current run.</div>' : ''}<section class="card">${content}</section>`;
  return page({title: report.path.split('/').at(-1), active: 'experiments-reports', signedIn, body, next: `${BASE}/report?path=${encodeURIComponent(report.path)}`});
}

/** `/experiments/questions`: questions.md rendered. */
export function questionsPageHtml({questions, root, signedIn = true}) {
  const body = `${crumbs(['Open questions'])}<h1>Open owner questions</h1>
${questions ? `<p class="meta"><code>questions.md</code> · updated ${when(questions.mtime)} · ${questions.open.length} open. Answer on the <code>**Răspuns:**</code> line of each question (<a href="vscode://file${esc(questions.path)}">open in VS Code</a>). A question disappears from the file once its decision is implemented; the decision is kept in the journal, the notes and the owning specification.</p><section class="card">${md(questions.text, root)}</section>` : '<p class="muted">questions.md not found.</p>'}`;
  return page({title: 'Open questions', active: 'experiments-questions', signedIn, body, next: `${BASE}/questions`});
}

/** A 404 page inside the section. */
export function notFoundHtml({what, signedIn = true}) {
  return page({title: 'Not found', active: 'experiments-index', signedIn, body: `${crumbs(['Not found'])}<h1>Not found</h1><p>${esc(what)}</p><p><a href="${BASE}">Back to the index</a></p>`, next: BASE});
}
