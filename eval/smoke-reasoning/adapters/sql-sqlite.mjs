/**
 * Adapter for the product strategy `sql-sqlite` (reasoning/strategies/sql-sqlite/): the desugared core compiled to SQL and run by the
 * built-in node:sqlite. It hands the knowledge and query circuits of the case, as text, to the strategy, which uses the oracle's own
 * front end (governance, desugaring, program compiler) and lowers the rest to tables, INSERT ... SELECT, recursive CTEs, a semi-naive
 * loop, NOT EXISTS and GROUP BY. Per-row `conditional` is the host rule applied by the harness around every strategy.
 */
import {sqlSqlite, NotExpressibleError} from '../../../reasoning/strategies/sql-sqlite/index.mjs';
import {NotExpressible} from './common.mjs';

export const sqlSqliteAdapter = {
  id: 'sql-sqlite', status: 'available', origin: 'reasoning/strategies/sql-sqlite/ (node:sqlite: tables per predicate polarity, recursive CTE and semi-naive loop, NOT EXISTS, GROUP BY)',
  description: 'The Datalog core compiled to SQL on the built-in node:sqlite: bulk joins and aggregates as set-at-a-time statements, linear recursion as a recursive CTE, nonlinear and mutual recursion as a semi-naive loop, tick() as probe ceiling and statement timeout.',
  supports: new Set(sqlSqlite.features),
  available: () => sqlSqlite.available(),
  async run(c, ctx) {
    try {
      const packet = sqlSqlite.ask({theory: {knowledge: c.knowledge}, query: c.query}, {}, {conditional: false});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
