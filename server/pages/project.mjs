/** Timeline & live status page (`/experiments/timeline`, formerly `/project`):
 * the owner's near-real-time view. The rest of the project history (tasks,
 * experiments, topic notes, reports, questions) is on the other `/experiments`
 * pages (server/pages/history.mjs).
 *
 * The page polls `/experiments/api/status` every 15 seconds and whenever the tab
 * regains focus, and renders: the current phase and the gates (training needs
 * the owner's explicit approval per run), the live journal
 * timeline filterable by area, the data pipeline per corpus, the experiment
 * registry, the open owner questions from `questions.md`, and explanations of
 * what fine-tuning will do. The explanations are static text; everything else
 * comes from files on each poll (server/project.mjs).
 */
import {layout} from './layout.mjs';

const style = `
.status{max-width:1200px}
.banner{border:2px solid var(--bad);background:color-mix(in srgb,var(--bad) 10%,var(--panel));border-radius:10px;padding:12px 16px;margin:0 0 14px}
.banner b.big{font-size:1.2rem;color:var(--bad)}
.cols{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px}
@media (max-width:980px){.cols{grid-template-columns:1fr}}
.card h2{font-size:1.1rem;margin:0 0 8px}
table.t{border-collapse:collapse;width:100%;font-size:14px}
table.t td,table.t th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
table.t th{color:var(--muted);font-weight:600;font-size:13px}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.gate{font-weight:700;white-space:nowrap}
.gate.open{color:var(--ok)}.gate.closed{color:var(--bad)}.gate.prohibited{color:#fff;background:var(--bad);padding:1px 6px;border-radius:5px}
.tablewrap{overflow-x:auto}
.filters{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 8px}
.filters button{padding:2px 10px;font-size:13px;border-radius:12px}
.filters button.on{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
ol.timeline{list-style:none;margin:0;padding:0;max-height:70vh;overflow:auto}
ol.timeline li{border-left:3px solid var(--line);padding:4px 0 10px 12px;margin-left:4px;position:relative}
ol.timeline li::before{content:'';position:absolute;left:-7px;top:9px;width:11px;height:11px;border-radius:50%;background:var(--line)}
ol.timeline li.s-done::before{background:var(--ok)}ol.timeline li.s-blocked::before{background:var(--bad)}ol.timeline li.s-decision::before{background:#8250df}ol.timeline li.s-started::before,ol.timeline li.s-progress::before{background:var(--accent)}
.meta{font-size:12px;color:var(--muted)}
.tag{font-size:11px;padding:0 6px;border-radius:8px;border:1px solid var(--line);background:var(--soft);margin-right:4px}
.tag.decision{border-color:#8250df;color:#8250df}.tag.blocked{border-color:var(--bad);color:var(--bad)}
.detailtext{white-space:pre-wrap;font-size:14px;margin:3px 0}
.links a,.links code{font-size:12px;margin-right:8px}
.md h1,.md h2,.md h3{font-size:1rem;margin:10px 0 4px}
.md p{margin:4px 0}
.explain p,.explain li{font-size:14px;line-height:1.6}
.flow{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:13px;margin:6px 0}
.flow span{padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--soft)}
.flow span.future{border-style:dashed;color:var(--muted)}
.flow i{color:var(--muted);font-style:normal}
#stamp{font-size:12px}
`;

/** Browser code. Runs as `(${client})()`, so it must not close over module scope. */
function client() {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]);
  const pct = value => (value === null || value === undefined ? '—' : (100 * value).toFixed(1) + '%');
  let area = new URLSearchParams(location.hash.slice(1)).get('area') || '';
  let data = null;

  /** A link to a repository path: docs pages are served under /docs/, other paths are shown as code. */
  const linkOf = target => {
    if (/^https?:\/\//.test(target)) return '<a href="' + esc(target) + '" target="_blank" rel="noopener">' + esc(target) + '</a>';
    const spec = /^docs\/specs\/(DS\d+[^/]*\.md)$/.exec(target);
    if (spec) return '<a href="/docs/specsLoader.html?spec=' + encodeURIComponent(spec[1]) + '">' + esc(target) + '</a>';
    if (/^docs\/.+\.html$/.test(target)) return '<a href="/' + esc(target) + '">' + esc(target) + '</a>';
    return '<code>' + esc(target) + '</code>';
  };

  /** Minimal Markdown for questions.md: headings, lists, paragraphs, **bold**, `code`. */
  function markdown(text) {
    const inline = line => esc(line).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const out = [];
    let list = false;
    for (const line of text.split('\n')) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (!item && list) out.push('</ul>'), list = false;
      if (heading) out.push('<h' + (heading[1].length + 1) + '>' + inline(heading[2]) + '</h' + (heading[1].length + 1) + '>');
      else if (item) {
        if (!list) out.push('<ul>'), list = true;
        out.push('<li>' + inline(item[1]) + '</li>');
      } else if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    }
    if (list) out.push('</ul>');
    return out.join('');
  }

  function renderGates() {
    $('rule').textContent = data.phase.rule ?? 'AGENTS.md Direction 3: training happens only with the owner\'s explicit approval per run.';
    $('gates').innerHTML = '<table class="t"><thead><tr><th>gate</th><th>state</th><th>evidence (computed now)</th></tr></thead><tbody>' + data.gates.map(gate =>
      '<tr><td>' + esc(gate.title) + (gate.note ? '<div class="meta">' + esc(gate.note) + '</div>' : '') + '</td><td>' +
      (gate.perRun ? '<span class="gate prohibited">OWNER, PER RUN</span>' : gate.prohibited ? '<span class="gate prohibited">PROHIBITED</span>' : '<span class="gate ' + (gate.open ? 'open">✓ open' : 'closed">✗ closed') + '</span>') +
      '</td><td>' + esc(gate.evidence) + '<div class="meta">' + esc(gate.source) + '</div></td></tr>').join('') + '</tbody></table>' +
      '<p class="meta" style="margin:6px 0 0">An open check is an observation, never an approval: only the owner opens the training gate.</p>';
  }

  function renderTimeline() {
    $('filters').innerHTML = ['', ...data.areas].map(name => '<button type="button" data-area="' + esc(name) + '"' + (name === area ? ' class="on"' : '') + '>' + esc(name || 'all') + '</button>').join('');
    if (data.journalError) {
      $('timeline').innerHTML = '<li class="bad">' + esc(data.journalError) + '</li>';
      return;
    }
    $('timeline').innerHTML = data.journal.map(event =>
      '<li class="s-' + esc(event.state) + '"><div class="meta">' + esc(new Date(event.ts).toLocaleString()) + ' · ' + esc(event.actor) + '</div>' +
      '<div><span class="tag">' + esc(event.area) + '</span><span class="tag ' + esc(event.state) + '">' + esc(event.state) + '</span><b>' + esc(event.title) + '</b></div>' +
      (event.detail ? '<div class="detailtext">' + esc(event.detail) + '</div>' : '') +
      (event.links.length ? '<div class="links">' + event.links.map(linkOf).join('') + '</div>' : '') + '</li>').join('') || '<li class="muted">No journal events for this filter.</li>';
  }

  function renderPipeline() {
    const rows = data.pipeline.map(entry => '<tr><td><code>' + esc(entry.corpus) + '</code></td><td class="num">' + (entry.splits.test ?? '—').toLocaleString() + '</td><td>' + (entry.test_file ? '<code>' + esc(entry.test_file) + '</code>' : '<span class="muted">no sealed test</span>') + '</td></tr>').join('');
    $('pipeline').innerHTML = '<div class="tablewrap"><table class="t"><thead><tr><th>suite</th><th class="num">sealed test rows</th><th>file</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="meta">The sealed suites of the product under <code>eval/suites/</code>. The suites of the frozen small-model branch are in <code>probably_obsolete/tinyLLMExperiments/</code>. Every test, evaluation and harness with its latest result: <a href="/docs/tests-inventory.html">the inventory of tests and evaluations</a>.</p>';
    $('vocab').textContent = '';
  }

  /** One registry entry (DS007 "Experiments"): identity, what was done, data, models, results, deviations, reports. */
  function experimentCard(x) {
    const list = (items, fn) => Array.isArray(items) && items.length ? '<ul>' + items.map(item => '<li>' + fn(item) + '</li>').join('') + '</ul>' : '';
    const short = hash => (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? '<code title="' + esc(hash) + '">' + esc(hash.slice(0, 12)) + '…</code>' : esc(hash ?? ''));
    const text = value => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
    const fields = [
      ['category', esc(x.category ?? 'preregistered') + (x.kind ? '<div class="meta">' + esc(x.kind) + '</div>' : '')],
      ['hypothesis', esc(x.hypothesis)],
      ['what was done', esc(x.done ?? x.method ?? '')],
      ['preregistration', /^none: /.test(x.preregistration) ? esc(x.preregistration) : linkOf(x.preregistration.split(' ')[0]) + ' ' + esc(x.preregistration.split(' ').slice(1).join(' '))],
      ['data version', esc(x.data_version)],
      ['datasets', list(x.datasets, d => (typeof d === 'string' ? esc(d) : '<b>' + esc(d.name ?? '') + '</b> ' + (d.path ? linkOf(d.path) : '') + (d.sha256 ? ' sha256 ' + short(d.sha256) : '') + (d.rows ? ' · ' + esc(d.rows) + ' rows' : '') + (d.role ? ' · ' + esc(d.role) : '')))],
      ['models', list(x.models, m => (typeof m === 'string' ? esc(m) : '<b>' + esc(m.name ?? '') + '</b> ' + esc([m.identity, m.version, m.quantization, m.runtime, m.status].filter(Boolean).join(' · '))))],
      ['metrics', list(x.metrics, m => esc(text(m)))],
      ['results', esc(x.results_summary ?? '') + (x.results ? '<details><summary class="meta">machine-readable results</summary><pre class="detailtext">' + esc(JSON.stringify(x.results, null, 1)) + '</pre></details>' : (x.results_summary ? '' : '<span class="muted">none yet</span>'))],
      ['deviations', list(x.deviations, d => (typeof d === 'string' ? esc(d) : '<b>' + esc(d.id ?? '') + '</b> ' + esc(d.at ?? '') + ' — ' + esc(d.what ?? '') + (d.effect ? ' <span class="meta">Effect: ' + esc(d.effect) + '</span>' : '')))],
      ['conclusions', esc(text(x.conclusions)) || '<span class="muted">none yet</span>'],
      ['reports', list(x.reports ?? x.links, linkOf)],
    ].filter(([, value]) => value);
    return '<details class="card" style="margin:8px 0"' + (x.status === 'running' ? ' open' : '') + '><summary><code>' + esc(x.id) + '</code> <b>' + esc(x.name ?? '') + '</b> <span class="tag">' + esc(x.status) + '</span>' +
      (x.registered_at ?? x.date ? '<span class="meta"> ' + esc(x.registered_at ?? x.date) + '</span>' : '') + '</summary>' +
      '<div class="tablewrap"><table class="t"><tbody>' + fields.map(([name, value]) => '<tr><th style="width:12em">' + esc(name) + '</th><td>' + value + '</td></tr>').join('') + '</tbody></table></div></details>';
  }

  function renderExperiments() {
    $('experiments').innerHTML = data.experimentsError ? '<p class="bad">' + esc(data.experimentsError) + '</p>' : data.experiments.length
      ? data.experiments.map(experimentCard).join('')
      : '<p class="muted">No experiments registered. There are no valid training runs; an experiment is preregistered here (DS007) before any holdout is touched.</p>';
  }

  function renderQuestions() {
    const q = data.questions;
    $('questions').innerHTML = q ? '<div class="md">' + markdown(q.text) + '</div><p class="meta">Edit <code>questions.md</code> at the repository root: write your answer on the <code>**Răspuns:**</code> line (<a href="vscode://file' + esc(q.path) + '">open in VS Code</a>). Updated ' + esc(q.mtime.slice(0, 16).replace('T', ' ')) + '.</p>' : '<p class="muted">questions.md not found.</p>';
  }

  async function refresh() {
    try {
      const response = await fetch('/experiments/api/status' + (area ? '?area=' + encodeURIComponent(area) : ''), {credentials: 'same-origin'});
      if (response.status === 401) {
        location.href = '/login?next=' + encodeURIComponent('/experiments/timeline' + location.hash);
        return;
      }
      data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'HTTP ' + response.status);
      renderGates();
      renderTimeline();
      renderPipeline();
      renderExperiments();
      renderQuestions();
      $('stamp').textContent = 'updated ' + new Date(data.generated).toLocaleTimeString() + ' · refreshes every 15 s and on focus';
    } catch (error) {
      $('stamp').textContent = 'refresh failed: ' + error.message;
    }
  }

  $('filters').addEventListener('click', event => {
    const button = event.target.closest('[data-area]');
    if (!button) return;
    area = button.dataset.area;
    history.replaceState(null, '', area ? '#area=' + encodeURIComponent(area) : '#');
    refresh();
  });
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  refresh();
}

/** The `/experiments/timeline` page shell; data arrives from `/experiments/api/status`. */
export function projectPage({signedIn = true} = {}) {
  const body = `<main class="wrap status">
<nav class="meta"><a href="/experiments">Experiments</a> › Timeline &amp; live status</nav>
<h1>Timeline &amp; live status <span id="stamp" class="muted"></span></h1>
<div class="banner"><b class="big">Training: only with the owner's explicit approval per run</b> <span id="rule" class="muted"></span><div class="meta">Current phase: the product chain (the coding agent writes circuits; the validator, the KnowledgeLinker, the StrategyRouter and the oracle answer) and its evaluation. An approval covers the run it names and is spent when that run ends; no check below supplies it.</div></div>
<section class="card"><h2>Gates</h2><div id="gates" class="muted">loading…</div></section>
<div class="cols">
<section class="card"><h2>Journal — newest first</h2><div class="filters" id="filters"></div><ol class="timeline" id="timeline"></ol><p class="meta">Agents append with <code>node tools/journal.mjs add --area … --title … --detail …</code>; the file is <code>status/journal.jsonl</code> (append-only).</p></section>
<div>
<section class="card"><h2>Open questions for the owner</h2><div id="questions" class="muted">loading…</div></section>
<section class="card"><h2>Experiments</h2><div id="experiments" class="muted">loading…</div><p class="meta"><code>status/experiments.json</code> · one page per experiment and task on <a href="/experiments">/experiments</a> · preregistration rules: <a href="/docs/specsLoader.html?spec=DS007-experiment-preregistration.md">DS007</a></p></section>
</div></div>
<section class="card"><h2>Evaluation suites (computed live)</h2><div id="pipeline" class="muted">loading…</div><p id="vocab" class="meta"></p></section>
</main>`;
  return layout({title: 'Timeline & live status · MRP-LLM', active: 'experiments-timeline', signedIn, body, style, script: `(${client})();`, next: '/experiments/timeline'});
}
