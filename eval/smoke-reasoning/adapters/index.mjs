import {jsOracle} from './js-oracle.mjs';
import {prologTablingAdapter} from './prolog-tabling.mjs';
import {datalogSoplabAdapter} from './datalog-soplab.mjs';
import {datalogE10Adapter} from './datalog-e10.mjs';
import {vrcCompressedPlanning} from './vrc-compressed-planning.mjs';
import {closureTemplate} from './closure-template.mjs';
import {datalogSouffleAdapter} from './datalog-souffle.mjs';
import {worldsSopr} from './worlds-sopr.mjs';
import {aspClingoAdapter} from './asp-clingo.mjs';
import {sqlSqliteAdapter} from './sql-sqlite.mjs';
import {dreamingSessionAdapter} from './dreaming-session.mjs';
import {z3SmtBoundedAdapter} from './z3-smt-bounded.mjs';
import {htnPlanner} from './htn-strips-planner.mjs';
import {gologSwiAdapter} from './golog-swi.mjs';
import {llmAgentAdapters} from './llm-agent.mjs';
import {plannedAdapters} from './planned.mjs';
import {codeSandboxAdapter} from './code-sandbox.mjs';

/**
 * One adapter per STRATEGY. The default columns are the product strategies: the oracle `js-oracle` (which is also the `reference` route of the
 * runtime) and the strategies that are compared with it. The retired route columns (`js-reference` = the old `reference`, `prolog-swi` and
 * `z3-lia` = the old `advanced`) were removed on 2026-10-01: the oracle replaced the old reasoner, prolog-tabling the SWI adapter and
 * z3-smt-bounded the Z3 adapter. Two more pools are opt-in: the reference engines (`--with-reference-engines`, independent implementations
 * kept for differential tests) and the frozen strategies (`--with-frozen`); naming one of them with `--adapter` runs it.
 */
export const adapters = [jsOracle, prologTablingAdapter, datalogE10Adapter, vrcCompressedPlanning, closureTemplate, worldsSopr, dreamingSessionAdapter, datalogSouffleAdapter, aspClingoAdapter, sqlSqliteAdapter, z3SmtBoundedAdapter, htnPlanner, codeSandboxAdapter, ...llmAgentAdapters, ...plannedAdapters];
export const referenceEngineAdapters = [datalogSoplabAdapter];
export const frozenAdapters = [gologSwiAdapter];
