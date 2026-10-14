import test from 'node:test';
import assert from 'node:assert/strict';
import {packBatches, parseFindings, parseRepairs, reviewLoop, loadKind, score, estimateTokens} from '../../lib/llm-review/index.mjs';

const items = (n, ctx = null) => Array.from({length: n}, (_, i) => ({id: `i${i}`, material: 'm'.repeat(350), work: 'w'.repeat(350), ...(ctx ? {context_id: ctx, context: 'C'.repeat(3500)} : {})}));

test('packing respects the token budget and prints a shared context once per batch', () => {
  const list = items(10, 'p1');
  const batches = packBatches(list, {budgetTokens: 2000});
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap(b => b.items.map(i => i.id)), list.map(i => i.id));
  for (const b of batches) {
    assert.ok(b.tokens <= 2000 || b.items.length === 1, `batch ${b.index} ${b.tokens}`);
    assert.equal(b.text.split('=== CONTEXT p1 ===').length - 1, 1);
    assert.ok(Math.abs(estimateTokens(b.text) - b.tokens) < 50);
  }
  const big = packBatches([{id: 'x', material: 'a'.repeat(50000), work: 'b'}], {budgetTokens: 1000});
  assert.equal(big.length, 1);
});

test('reviewer output is parsed robustly: fences, arrays, unknown ids, bad severities, missing end marker', () => {
  const ok = parseFindings('```json\n{"id":"a","problem":"wrong number","severity":"high"}\n[{"id":"b","problem":"x","severity":"weird"}]\n{"id":"zz","problem":"y","severity":"low"}\nsome prose\n{"done": true}\n```', ['a', 'b']);
  assert.equal(ok.malformed, false);
  assert.deepEqual(ok.findings.map(f => [f.id, f.severity]), [['a', 'high'], ['b', 'medium']]);
  assert.deepEqual(ok.unknownIds, ['zz']);
  assert.equal(parseFindings('{"done":true}', ['a']).findings.length, 0);
  assert.equal(parseFindings('', ['a']).malformed, true);
  assert.equal(parseFindings('{"id":"a","problem":"p","severity":"high"}', ['a']).malformed, true, 'no end marker');
  const rep = parseRepairs('{"id":"a","work":"@f fact\\n  holds p x","note":"n"}\n{"id":"b","work":null,"reason":"needs source"}\n{"done":true}', ['a', 'b']);
  assert.deepEqual(rep.repairs.map(r => [r.id, r.work == null]), [['a', false], ['b', true]]);
});

/** A stub model: reviews by rules on the work text, repairs by replacing BAD with GOOD (or NEVER with an invalid fix). */
function stubModel({malformedOnce = false} = {}) {
  let first = true;
  const calls = [];
  const call = async ({system, user}) => {
    calls.push(system.slice(0, 30));
    const ids = [...user.matchAll(/=== ITEM (\S+)/g)].map(m => m[1]);
    const blocks = user.split('=== ITEM ').slice(1);
    const usage = {in: 100, out: 10, reasoning: 0};
    if (/repair/i.test(system.split('\n')[0])) {
      const lines = blocks.map((b, i) => {
        const work = b.split('WORK:\n')[1].split('\nPROBLEMS FOUND:')[0];
        if (work.includes('NEVER')) return JSON.stringify({id: ids[i], work: 'still broken ('});
        if (work.includes('DECLINE')) return JSON.stringify({id: ids[i], work: null, reason: 'needs the source'});
        return JSON.stringify({id: ids[i], work: work.replace('BAD', 'GOOD').replace('MAYBE', 'GOOD')});
      });
      return {text: lines.join('\n') + '\n{"done":true}', usage, usd: 0.001};
    }
    if (malformedOnce && first) { first = false; return {text: 'I think everything is fine.', usage, usd: 0.001}; }
    const second = /second/.test(system) ? '' : '';
    const lines = blocks.flatMap((b, i) => {
      const work = b.split('WORK:\n')[1];
      if (/BAD|NEVER|DECLINE/.test(work)) return [JSON.stringify({id: ids[i], problem: 'wrong', severity: 'high'})];
      if (/MAYBE/.test(work)) return [JSON.stringify({id: ids[i], problem: 'unsure', severity: 'medium'})];
      if (/STYLE/.test(work)) return [JSON.stringify({id: ids[i], problem: 'style', severity: 'low'})];
      return [];
    });
    return {text: lines.join('\n') + second + '\n{"done":true}', usage, usd: 0.001};
  };
  return {call, calls};
}

const kind = {review: 'Review the items.', repair: 'Repair the items.', protocol: 'P', repairProtocol: 'RP', policy: {repairAt: 'high', confirmAt: 'medium', secondOpinion: true, maxRepairRounds: 2}};

test('the loop repairs confirmed problems, checks, re-reviews and escalates only what stays unresolved', async () => {
  const list = [
    {id: 'good', material: 'm', work: 'fine'},
    {id: 'bad', material: 'm', work: 'value BAD'},
    {id: 'unsure', material: 'm', work: 'value MAYBE'},
    {id: 'style', material: 'm', work: 'STYLE'},
    {id: 'never', material: 'm', work: 'NEVER'},
    {id: 'decline', material: 'm', work: 'DECLINE'},
  ];
  const {call} = stubModel({malformedOnce: true});
  const check = (item, work) => (work.includes('(') ? {ok: false, problems: ['unbalanced parenthesis']} : {ok: true, problems: []});
  const r = await reviewLoop({items: list, kind, call, check});
  assert.deepEqual(r.repaired.map(x => [x.id, x.work]).sort(), [['bad', 'value GOOD'], ['unsure', 'value GOOD']]);
  assert.deepEqual(r.noted.map(x => x.id), ['style']);
  assert.deepEqual(r.escalations.map(e => [e.id, e.reason]).sort(), [['decline', 'repair_declined'], ['never', 'check_failed']]);
  assert.equal(r.ledger.stages.review.retries, 1, 'the malformed batch was retried once');
  assert.ok(r.ledger.total().usd > 0);
  assert.ok(!r.confirmed.includes('good'));
});

test('a second opinion that disagrees dismisses a medium finding; no repair escalates confirmed items', async () => {
  let pass = 0;
  const call = async ({user}) => {
    pass += 1;
    const id = [...user.matchAll(/=== ITEM (\S+)/g)].map(m => m[1])[0];
    return {text: (pass === 1 ? JSON.stringify({id, problem: 'maybe', severity: 'medium'}) + '\n' : '') + '{"done":true}', usage: {in: 1, out: 1, reasoning: 0}, usd: 0};
  };
  const r = await reviewLoop({items: [{id: 'a', material: 'm', work: 'w'}], kind, call});
  assert.deepEqual(r.dismissed.map(d => d.id), ['a']);
  assert.equal(r.escalations.length, 0);
  const {call: c2} = stubModel();
  const r2 = await reviewLoop({items: [{id: 'b', material: 'm', work: 'BAD'}], kind, call: c2, repair: false});
  assert.deepEqual(r2.escalations.map(e => [e.id, e.reason]), [['b', 'confirmed_problem']]);
});

test('review kinds load from config/review and scoring counts recall and false alarms', () => {
  for (const name of ['knowledge-wires', 'query-circuits']) {
    const k = loadKind(name);
    assert.ok(k.review.length > 100 && k.repair.length > 50 && k.protocol.includes('{"done": true}'));
    assert.equal(k.check.validator, 'sop-knowledge');
  }
  assert.throws(() => loadKind('no-such-kind'));
  const s = score(['a', 'c'], {a: true, b: true, c: false, d: false});
  assert.deepEqual([s.tp, s.fn, s.fp, s.tn, s.recall, s.false_alarm_rate], [1, 1, 1, 1, 0.5, 0.5]);
});
