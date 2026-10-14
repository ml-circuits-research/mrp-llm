/**
 * ChatSOP's TaskLambdas (registered in the Ploinky user configuration (~/.pworker/config.json) `lambdas.project`; they run inside the Ploinky Workers server, one call at a
 * time in a worker, and reach models only through Ploinky Workers). Effects: model calls, and the private chat session each turn opens in the
 * chat data folder (writes-external).
 *
 *   formalize    one message through the chat turn of ChatSOPAdapter (mode stepwise by default: the step-by-step formalizer, the
 *                validator, the KnowledgeLinker, the StrategyRouter, the oracle, the rendering) in a fresh session of a base memory;
 *                returns the circuit, the answer text and the parse record.
 *   chat-batch   the same turn over many messages (an attached JSONL of {id, question}): the batch runs of the evaluation harnesses,
 *                through the same backend as the chat; writes answers.jsonl into the operation folder and returns counts.
 * Both open the turn with tools/eval/books/system.mjs `openChatTurn` (the evaluation harnesses' session setup), so a TaskLambda call and an
 * evaluation run answer identically.
 */
import fs from 'node:fs';
import path from 'node:path';

const MODES = ['stepwise', 'routed', 'direct-verified'];
const TIERS = ['nano', 'micro', 'tiny', 'small', 'medium', 'good'];
const common = {
  mode: {type: 'string', enum: MODES, default: 'stepwise', description: 'the ChatSOPAdapter mode'},
  tier: {type: 'string', enum: TIERS, required: false, description: 'answer every step-by-step question on this tier (default: the product ladder of config/runtime.json)'},
  base: {type: 'string', max: 64, required: false, description: 'the base memory of the session (default: the chat default base)'},
  priority: {type: 'string', enum: ['normal', 'background'], default: 'normal', description: 'background: run only in quiet periods, within the plan headroom'},
};

async function open(ctx) {
  const {openChatTurn} = await import('../../tools/eval/books/system.mjs');
  const {mode, tier, base, priority} = ctx.params;
  return openChatTurn({base: base ?? null, mode, tier: tier ?? null, ladder: !tier, localExtra: {tags: {purpose: ctx.ta.purpose, run: ctx.ta.run ?? null, priority: priority === 'background' ? 'background' : null}}});
}
const summaryOf = r => ({ok: r.ok, text: r.text ?? null, sop: r.sop ?? null, status: r.packet?.status ?? null, verification: r.adapter?.verification?.status ?? null, error: r.error ?? null, ms: r.ms,
  parse: r.parse ? {strategy: r.parse.strategy ?? null, model: r.parse.model ?? null, ladder: r.parse.ladder ?? null, steps: r.parse.steps ?? null} : null});

const EFFECTS = Object.freeze(['model-calls', 'writes-external']);

export const lambdas = [
  {
    name: 'formalize',
    description: 'Formalize one message of a user into a SOP circuit and answer it the way the ChatSOP chat does (step-by-step formalizer, validator, reasoning, oracle), in a fresh session of a base memory.',
    effects: EFFECTS,
    params: {message: {type: 'string', min: 1, max: 8000, description: 'the message (a question or a problem)'}, ...common},
    async run(ctx) {
      const turn = await open(ctx);
      try {
        const r = await turn.ask(ctx.params.message);
        const out = summaryOf(r);
        fs.writeFileSync(path.join(ctx.dir, 'turn.json'), JSON.stringify(out, null, 1) + '\n');
        return {status: r.ok ? 'finished' : 'failed', summary: r.ok ? `${r.text ?? ''}\n${r.sop ?? ''}`.trim().slice(0, 2000) : `${r.error?.code}: ${r.error?.message}`, ...out};
      } finally { await turn.close(); }
    },
  },
  {
    name: 'chat-batch',
    description: 'Answer many questions (an attached JSONL of {id, question}) through the ChatSOP chat backend (ChatSOPAdapter), as the evaluation harnesses do; writes answers.jsonl and returns counts by status and verification.',
    effects: EFFECTS,
    params: {limit: {type: 'integer', min: 1, max: 5000, required: false, description: 'answer only the first N questions'}, ...common},
    attachments: 'required',
    async run(ctx) {
      if (!ctx.attachments.length) return {status: 'failed', summary: 'attach a JSONL file of {id, question} lines'};
      const rows = [];
      for (const a of ctx.attachments) for (const line of (await ctx.readAttachment(a.name)).split('\n')) if (line.trim()) rows.push(JSON.parse(line));
      const todo = rows.filter(r => r && r.question).slice(0, ctx.params.limit ?? Infinity);
      const file = path.join(ctx.dir, 'answers.jsonl');
      const turn = await open(ctx);
      const counts = {answered: 0, failed: 0, by_status: {}, by_verification: {}};
      try {
        for (const [i, row] of todo.entries()) {
          const r = summaryOf(await turn.ask(String(row.question)));
          fs.appendFileSync(file, JSON.stringify({id: row.id ?? i + 1, ...r}) + '\n');
          if (r.ok) counts.answered += 1; else counts.failed += 1;
          counts.by_status[r.status ?? 'none'] = (counts.by_status[r.status ?? 'none'] ?? 0) + 1;
          counts.by_verification[r.verification ?? 'none'] = (counts.by_verification[r.verification ?? 'none'] ?? 0) + 1;
          if ((i + 1) % 10 === 0) ctx.log(`${i + 1}/${todo.length} answered`);
        }
      } finally { await turn.close(); }
      return {status: 'finished', summary: `${todo.length} questions (${ctx.params.mode}): answered ${counts.answered}, failed ${counts.failed}; status ${JSON.stringify(counts.by_status)}; verification ${JSON.stringify(counts.by_verification)}; ${path.relative(process.cwd(), file)}`, counts, answers: file};
    },
  },
];
