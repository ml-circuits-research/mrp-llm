#!/usr/bin/env node
/** Usage examples for the research corpus designs, executed through the real host
 * path: declarative SOP in, host-compiled circuit out. No model is called.
 *
 *   1. proposition — question intent as a declarative query (employment domain)
 *   2. polarity    — explicit negation flips the answer (IT incident domain)
 *   3. temporal    — the evaluation time flips the answer (project staffing)
 *   4. ambiguity   — an unresolved mention yields a host clarification (sites)
 *
 * Every scenario carries its own inline lexicon and fictitious knowledge, so the
 * examples do not depend on the kinship demo fixture used by the CLI tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../../sop/runtime.mjs';
import {Repository} from '../../memory/repository.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {assert} from '../../lib/util.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsop-research-examples-'));
const text = name => fs.readFileSync(path.join(here, name), 'utf8').trim();
const half = (name, index) => text(name).split('\n# --- contrast ---\n')[index];
const show = (title, value) => console.log(`\n=== ${title} ===\n${JSON.stringify(value, null, 2)}`);

async function scenario(name, {ontology, facts, program, now = '2026-09-26T12:00:00Z'}) {
  const lexicon = new Lexicon(ontology);
  const repo = new Repository(path.join(work, name), {memory: {engine: 'sqlite', power: 10}});
  if (facts) publishKnowledge(repo, 'research', facts, {schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2024-01-01')});
  else repo.init('research');
  const session = repo.session('research', 'demo', name);
  return new Runtime({repo, session, schema: lexicon.predicates, lexicon, now: Date.parse(now)}).run(program, {origin: 'model', inputText: name, language: 'en'});
}

try {
  const employment = await scenario('employment', {
    ontology: `@works_at predicate
  args person organization
  label en "works at"
@maria entity
  kind person
  label en "Maria Ionescu"
@lab_north entity
  kind organization
  label en "North Lab"
@lab_south entity
  kind organization
  label en "South Lab"
`,
    facts: `@f1 fact
  holds works_at maria lab_north
  valid timeless
  source "fictitious research fixture"
`,
    program: text('proposition.sop'),
  });
  assert(employment.result.packet.status === 'supported', 'employment example must be supported');
  show('1. proposition — employment (design inspired by QA2D)', {
    authored: employment.authoredSop,
    circuit: employment.executionSop,
    status: employment.result.packet.status,
    answers: (employment.result.packet.answers ?? []).map(answer => answer.binding),
  });

  const incident = {
    ontology: `@network_down predicate
  args entity
  label en "network down"
@disk_full predicate
  args entity
  label en "disk full"
@server7 entity
  kind device
  label en "server7"
`,
    facts: `@f1 fact
  holds network_down server7
  valid timeless
  source "fictitious research fixture"
`,
  };
  const incidentPositive = await scenario('incident-positive', {...incident, program: half('polarity.sop', 0)});
  const incidentNegative = await scenario('incident-negative', {...incident, program: half('polarity.sop', 1)});
  assert(incidentPositive.result.packet.status === 'supported', 'positive incident claim must be supported');
  assert(incidentNegative.result.packet.status === 'refuted', 'negated incident claim must be refuted by the same evidence');
  const formatProof = packet => (packet.proof ?? []).map(entry => `${entry.kind === 'derived' ? 'derived' : 'given'} ${entry.atom?.p ?? ''} ${(entry.atom?.a ?? []).join(' ')}`.trim());
  show('2. polarity — IT incident (design inspired by high-overlap contrasts)', {
    positive: {status: incidentPositive.result.packet.status, depth: incidentPositive.result.packet.depth ?? null, proof: formatProof(incidentPositive.result.packet)},
    negated: {status: incidentNegative.result.packet.status, depth: incidentNegative.result.packet.depth ?? null},
    note: 'Only explicit negation differs between the two programs.',
  });

  const derived = await scenario('incident-derived', {
    ontology: `@network_down predicate
  args entity
  label en "network down"
@needs_attention predicate
  args entity
  label en "needs attention"
@server7 entity
  kind device
  label en "server7"
`,
    facts: `@f1 fact
  holds network_down server7
  valid timeless
  source "fictitious research fixture"

@attention rule
  when network_down ?device
  then needs_attention ?device
`,
    program: '@question query\n  where match\n    relation "needs attention"\n    role subject "server7"\n    polarity affirmed\n  end\n',
  });
  assert(derived.result.packet.status === 'supported', 'derived incident claim must be supported');
  assert(derived.result.packet.depth === 1, 'one chained rule must report depth 1');
  show('2b. derivation depth (rule supplied as approved setup, not by the model)', {
    status: derived.result.packet.status,
    depth: derived.result.packet.depth,
    proof: formatProof(derived.result.packet),
    authored: derived.authoredSop,
    note: 'The rule lives in the reviewed setup; the model only asked the question.',
  });

  const staffing = {
    ontology: `@project_member predicate
  args person project
  label en "member of project"
@maria entity
  kind person
  label en "Maria Ionescu"
@project_delta entity
  kind project
  label en "Delta programme"
`,
    facts: `@f1 fact
  holds project_member maria project_delta
  valid 2025-01-01 2025-07-01
  source "fictitious research fixture"
`,
  };
  const insideWindow = await scenario('staffing-inside', {...staffing, program: half('temporal.sop', 0)});
  const afterWindow = await scenario('staffing-after', {...staffing, program: half('temporal.sop', 1)});
  assert(insideWindow.result.packet.status === 'supported', 'claim inside the validity window must be supported');
  assert(afterWindow.result.packet.status === 'unknown', 'claim after the exclusive end must stay unknown');
  show('3. temporal — project staffing (authored window contrast)', {
    insideWindow: insideWindow.result.packet.status,
    afterWindow: afterWindow.result.packet.status,
    note: 'The interval is start-inclusive and end-exclusive; no closed-world assumption applies.',
  });

  const ambiguity = await scenario('ambiguity', {
    ontology: `@serviced predicate
  args entity
  label en "serviced"
@bay_north entity
  kind entity
  label en "Bay A"
@bay_south entity
  kind entity
  label en "Bay A"
`,
    facts: null,
    program: text('ambiguity.sop'),
  });
  assert(ambiguity.result.packet.status === 'clarify', 'ambiguous mention must produce a host clarification');
  show('4. ambiguity — maintenance sites (design inspired by ambiguity datasets)', {
    status: ambiguity.result.packet.status,
    reason: ambiguity.result.packet.reason,
    required: ambiguity.result.packet.required,
    pendingSop: ambiguity.result.packet.pendingSop,
    next: ambiguity.result.packet.next,
    question: ambiguity.result.text,
  });

  const geography = await scenario('geography', {
    ontology: `@located_in predicate
  role subject entity
  role location place
  label en "located in"
@harbour_h1 entity
  kind entity
  label en "Harbour H1"
@harbour_h2 entity
  kind entity
  label en "Harbour H2"
@north_delta entity
  kind place
  label en "North Delta"
`,
    facts: `@f1 fact
  holds located_in harbour_h1 north_delta
  valid timeless
  source "fictitious research fixture"

@f2 fact
  holds located_in harbour_h2 north_delta
  valid timeless
  source "fictitious research fixture"
`,
    program: text('spatial.sop'),
  });
  assert(geography.result.packet.status === 'supported', 'spatial question must be supported');
  assert((geography.result.packet.answers ?? []).length === 2, 'spatial question must return both sites');
  show('5. spatial — geography and travel (authored)', {
    status: geography.result.packet.status,
    answers: (geography.result.packet.answers ?? []).map(answer => answer.binding),
  });

  const agriculture = await scenario('agriculture', {
    ontology: `@irrigated predicate
  args plot
  label en "irrigated"
@plot_a entity
  kind plot
  label en "Plot A"
@plot_b entity
  kind plot
  label en "Plot B"
@plot_c entity
  kind plot
  label en "Plot C"
`,
    facts: `@f1 fact
  holds irrigated plot_a
  valid timeless
  source "fictitious research fixture"

@f2 fact
  holds irrigated plot_b
  valid timeless
  source "fictitious research fixture"
`,
    program: text('quantified.sop'),
  });
  assert(agriculture.result.packet.status === 'supported', 'counted question must be supported');
  assert(agriculture.result.packet.count === 2, 'counted question must report two irrigated plots');
  show('6. counted — agriculture and food (authored)', {
    status: agriculture.result.packet.status,
    count: agriculture.result.packet.count,
    note: 'A counted question is still a declarative target; the host compiles the linking and counting.',
  });
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}
