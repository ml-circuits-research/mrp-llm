/** The default backend: a fresh in-memory SQLite database per part of the time partition, the facts of the view loaded into tables. */
import {nativeCodec} from './codec.mjs';
import {Session} from './session.mjs';
import {createTables, indexAll, loadFacts, Kinds} from './schema.mjs';

export const memoryBackend = {
  id: 'memory',
  codec: nativeCodec,
  temp: false,
  kinds: program => new Kinds(program),
  open: budget => new Session({budget, codec: nativeCodec}),
  setup(session, {rels, program, view, kinds}) {
    createTables(session, rels);
    loadFacts(session, view, rels, kinds);
    const derived = (p, arity, neg) => program.rules.some(r => r.head.p === p && r.head.args.length === arity && r.head.neg === neg) || (!neg && program.aggregates.some(a => a.yields.p === p && a.yields.args.length === arity));
    // base relations are indexed once after the load; derived ones when their stratum is finished (closure.mjs)
    indexAll(session, rels, (p, arity, neg) => !derived(p, arity, neg));
  }
};
