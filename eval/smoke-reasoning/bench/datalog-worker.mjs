#!/usr/bin/env node
/**
 * One measurement of the speed table (driver: bench/datalog.mjs). Runs in its own process so that a wall-clock limit and a memory ceiling
 * can be enforced from outside, and prints one JSON line:
 *   node eval/smoke-reasoning/bench/datalog-worker.mjs '{"shape":"ring","params":{"components":1000,"size":10},"engine":"datalog-souffle","options":{}}'
 * The instance text is generated, split into chunks of 400 wires and parsed chunk by chunk (the grammar parser checks duplicate ids with a
 * linear scan, which is quadratic over one text of 10^5 wires), and handed to the strategy as structured wires (`theory.wires`), the way
 * a retrieved slice reaches an engine (proposal 11.3). The timed part is the strategy's `ask` alone.
 */
import {parse} from '../../../sop/knowledge/index.mjs';
import * as scale from './datalog-scale.mjs';

const SHAPES = {ring: scale.ringComponents, selective: scale.selectiveChain, dense: scale.denseNonlinear, negation: scale.negationChain, aggregates: scale.groupAggregates};

const IMPORTS = {
  'js-oracle': async () => (await import('../../../reasoning/strategies/js-reference/index.mjs')).ask,
  'datalog-souffle': async () => (await import('../../../reasoning/strategies/datalog-souffle/index.mjs')).ask,
  'datalog-e10': async () => (await import('../../../reasoning/strategies/datalog-e10/index.mjs')).ask,
  'datalog-soplab': async () => (await import('../../reference-engines/datalog-soplab/index.mjs')).ask,
  'sql-sqlite': async () => (await import('../../../reasoning/strategies/sql-sqlite/index.mjs')).ask
};

export function parseInChunks(text, size = 400) {
  const blocks = text.split(/\n(?=@)/);
  const wires = [];
  for (let i = 0; i < blocks.length; i += size) {
    const {wires: ws, errors} = parse(blocks.slice(i, i + size).join('\n') + '\n');
    if (errors.length) throw new Error(errors[0].message);
    wires.push(...ws);
  }
  return wires;
}

const key = r => JSON.stringify(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
const sameRows = (a, b) => a.length === b.length && JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort());

async function main() {
  const spec = JSON.parse(process.argv[2]);
  const inst = SHAPES[spec.shape](spec.params);
  const t0 = performance.now();
  const wires = parseInChunks(inst.knowledge);
  const parseMs = Math.round(performance.now() - t0);
  const ask = await IMPORTS[spec.engine]();
  const budget = spec.budget ?? {};
  const options = {conditional: false, ...(spec.options ?? {})};
  const problem = {theory: {wires}, query: inst.query};
  const reps = spec.reps ?? 1;
  const runs = [];
  let packet;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    packet = spec.engine === 'js-oracle' || spec.engine === 'sql-sqlite' ? ask(problem, budget) : ask(problem, budget, options);
    runs.push(Math.round(performance.now() - t));
  }
  const complete = packet.complete !== false;
  const correct = !complete ? null : inst.answer.rows ? sameRows(packet.rows ?? [], inst.answer.rows) : packet.count === inst.answer.count;
  console.log(JSON.stringify({
    ok: true, facts: inst.facts, parseMs, runs, ms: runs.at(-1), first: runs[0], status: packet.status, complete, reason: packet.budget?.reason ?? packet.reason ?? null, correct,
    answer: inst.answer.rows ? packet.rows?.length : packet.count, expected: inst.answer.rows ? inst.answer.rows.length : inst.answer.count,
    detail: packet.timings?.souffle ?? packet.timings?.e10 ?? null, rssMb: Math.round(process.memoryUsage().rss / 1048576)
  }));
}

main().catch(e => { console.log(JSON.stringify({ok: false, error: String(e.message ?? e).slice(0, 300)})); process.exit(0); });
