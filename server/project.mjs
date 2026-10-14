/** Live project status (`/experiments/timeline`, `/experiments/api/status`;
 * the former `/project/api/status` stays as an API alias) and the JSON APIs of
 * the project history (`/experiments/api/{tasks,topics,notes,report}`, data in
 * server/history.mjs).
 *
 * Everything on the page is computed on request from files, so it stays near
 * real time: the append-only journal and the experiment registry
 * (lib/journal.mjs, `status/`), the sealed evaluation suites on disk, the guards
 * of the evaluation boundary, the benchmark plan and `questions.md`.
 * Nothing here opens a gate: training stays prohibited until the owner's new
 * explicit approval, whatever the computed checks say.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recentEvents, readExperiments, journalFile, experimentsFile, statusDir, JOURNAL_AREAS} from '../lib/journal.mjs';
import {jsonlExists, shardPaths} from '../lib/jsonl-shards.mjs';
import {loadHistory, entries, topicSummaries, readReport, listReports} from './history.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Rows of a JSONL file (shards included): the newline count. */
function jsonlRows(file) {
  const parts = shardPaths(file);
  if (!parts.length) return null;
  let rows = 0;
  for (const part of parts) {
    const text = fs.readFileSync(part, 'utf8');
    rows += text.split('\n').filter(Boolean).length;
  }
  return rows;
}

/** The sealed evaluation suites under eval/suites/ with their row counts (the product keeps the KBQA suites and the linking suite). */
export function dataPipeline(root = projectRoot) {
  const base = path.join(root, 'eval/suites');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => {
    const test = path.join(base, entry.name, 'test.jsonl');
    const rows = jsonlExists(test) ? jsonlRows(test) : null;
    return {corpus: entry.name, splits: rows === null ? {} : {test: rows}, rows: rows ?? 0, test_file: rows === null ? null : path.relative(root, test)};
  }).sort((a, b) => a.corpus.localeCompare(b.corpus));
}

/** The AGENTS.md training rule (explicit owner approval per run), quoted live. */
function trainingRule(root) {
  const text = fs.existsSync(path.join(root, 'AGENTS.md')) ? fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8') : '';
  const line = text.split('\n').find(entry => /(?:Training happens only with|Training only with) the owner's explicit approval/.test(entry));
  return line ? line.replace(/^\d+\.\s*/, '').replace(/\*\*/g, '') : null;
}

/** Gates in order. `open` is a computed observation; training needs the owner's explicit approval per run and no gate supplies it. */
export function gates(root = projectRoot, {pipeline = dataPipeline(root), experiments = []} = {}) {
  const rule = trainingRule(root);
  const guards = ['eval/leakage.mjs', 'tests/formalizer/query-author.test.mjs', 'tests/reasoning/strategy-router.test.mjs'].map(file => ({file, exists: fs.existsSync(path.join(root, file))}));
  const prereg = experiments.filter(entry => ['preregistered', 'approved', 'running', 'done'].includes(entry.status));
  const benchmarkPlan = 'experiments/proposal/symbolic-vs-llm-benchmark.md';
  const smoke = readJson(path.join(root, 'eval/reports/current/chat-smoke/summary.json'));
  return [
    {id: 'owner-approval', title: 'Owner approval for training (per run)', open: false, prohibited: false, perRun: true,
      evidence: rule ?? "Training only with the owner's explicit approval per run (AGENTS.md)", source: 'AGENTS.md', note: 'Needed for every run and spent when the run ends. Never inferred from any check below.'},
    {id: 'suites', title: 'Sealed evaluation suites on disk (KBQA, linking)', open: pipeline.length > 0 && pipeline.every(entry => entry.rows > 0),
      evidence: pipeline.length ? pipeline.map(entry => `${entry.corpus} ${entry.rows} rows`).join('; ') : 'no suite under eval/suites/', source: 'eval/suites/'},
    {id: 'boundary-guards', title: 'Evaluation-boundary guards in place (leakage audit, circuit author and router tests)', open: guards.every(guard => guard.exists),
      evidence: `guards: ${guards.map(guard => `${guard.file} ${guard.exists ? 'present' : 'MISSING'}`).join('; ')} (run by npm test)`, source: 'tests/, eval/leakage.mjs'},
    {id: 'chat-smoke', title: 'Chat smoke through /v1/chat/completions with the coding agent', open: smoke?.ok === true,
      evidence: smoke ? `ok ${smoke.ok}${smoke.generated ? ' (' + smoke.generated + ')' : ''}` : 'no smoke record', source: 'eval/reports/current/chat-smoke/summary.json'},
    {id: 'benchmark-plan', title: 'Benchmark plan: symbolic reasoning against small LLMs', open: fs.existsSync(path.join(root, benchmarkPlan)),
      evidence: fs.existsSync(path.join(root, benchmarkPlan)) ? `${benchmarkPlan} present (the benchmark itself is not built yet)` : 'no plan', source: benchmarkPlan},
    {id: 'preregistration', title: 'Preregistered experiment (DS007)', open: prereg.length > 0,
      evidence: `${prereg.length} preregistered of ${experiments.length} registered`, source: 'status/experiments.json'},
  ];
}

/** questions.md, raw; the page renders it. */
function questions(root) {
  const file = path.join(root, 'questions.md');
  return fs.existsSync(file) ? {file: 'questions.md', path: file, text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtime.toISOString()} : null;
}

/** Everything `/project` shows, computed now. */
export function projectStatus({root = projectRoot, dir = statusDir(), area = null, limit = 300} = {}) {
  const pipeline = dataPipeline(root);
  let journalError = null, experimentsError = null, journal = [], registry = {experiments: []};
  try {
    journal = recentEvents({file: journalFile(dir), area, limit});
  } catch (error) {
    journalError = error.message;
  }
  try {
    registry = readExperiments({file: experimentsFile(dir)});
  } catch (error) {
    experimentsError = error.message;
  }
  return {
    generated: new Date().toISOString(),
    phase: {name: 'Product chain: coding agent circuits, validator, KnowledgeLinker, StrategyRouter, oracle', training: 'owner approval per run', rule: trainingRule(root)},
    gates: gates(root, {pipeline, experiments: registry.experiments}),
    journal, journalError, areas: JOURNAL_AREAS, journalFile: path.relative(root, journalFile(dir)) || journalFile(dir),
    pipeline,
    experiments: registry.experiments, experimentsNote: registry.note ?? null, experimentsError,
    questions: questions(root),
  };
}

/** Handles `/experiments/api/*` (and the alias `/project/api/*`); returns true when handled. Pages are served by server/web.mjs. */
export function createProjectRouter({root = projectRoot} = {}) {
  const handle = async (req, res, pathname, query, send) => {
    const match = /^\/(?:experiments|project)\/api\/([a-z]+)$/.exec(pathname);
    if (!/^\/(?:experiments|project)\/api\//.test(pathname)) return false;
    const endpoint = req.method === 'GET' ? match?.[1] : null;
    const history = () => loadHistory({root});
    if (endpoint === 'status') return send(200, projectStatus({root, area: JOURNAL_AREAS.includes(query.area) ? query.area : null})), true;
    if (endpoint === 'tasks') {
      const data = history();
      return send(200, {entries: entries(data), tasks: data.tasks, phase: data.phase, errors: data.errors}), true;
    }
    if (endpoint === 'topics') {
      const data = history();
      return send(200, {topics: topicSummaries(data).map(({latest, ...topic}) => ({...topic, latest: latest ? {id: latest.id, ts: latest.ts, kind: latest.kind, title: latest.title} : null})), errors: data.errors}), true;
    }
    if (endpoint === 'notes') {
      const data = history();
      const notes = data.notes.filter(note => (!query.topic || note.topic === query.topic) && (!query.kind || note.kind === query.kind) && (!query.author || note.author === query.author));
      return send(200, {notes, errors: data.errors}), true;
    }
    if (endpoint === 'report') {
      try {
        return send(200, query.path ? readReport(root, query.path) : listReports(root, query.dir ?? null)), true;
      } catch (error) {
        return send(error.status ?? 400, {error: {message: error.message, code: error.code ?? 'invalid_request'}}), true;
      }
    }
    send(404, {error: {message: 'Unknown experiments endpoint', code: 'not_found'}});
    return true;
  };
  return {handle};
}
