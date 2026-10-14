/** Orthogonal reasoning strategy registry. Memory choice never changes syntax.
 * reference: the js-reference oracle (reasoning/strategies/js-reference) through the runtime bridge (reasoning/bridge) and the
 * bounded controllers; `js-reference` and `js-oracle` are its ids. `prolog-tabling` and `z3-smt-bounded` are the explicit external
 * strategies (SWI-Prolog tabling for Horn, Z3 for integer constraints): a wire that names `backend prolog` or `backend z3` is
 * routed to the strategy of that backend (`STRATEGY_OF_BACKEND`).
 * A requested backend is never substituted (AGENTS.md rule 8): an explicit backend the chosen strategy cannot run, or a binary that is
 * not installed, is `unsupported` with the backend named in `route.backend` and `fallback: null`.
 */
import {spawnSync} from 'node:child_process';
import {abduce,diagnose} from './abduction.mjs';
import {associate,induce,analogize} from './learning.mjs';
import {plan,simulate} from './worlds.mjs';
import {flat,partitions,unsupported} from './common.mjs';
import {OPERATION_LIMITS} from './bridge/packet.mjs';
import {solveHorn,solveConstraint,optimize} from './bridge/solve.mjs';
import {assignmentsOf} from './strategies/js-reference/constraint-ast.mjs';
import {assert} from '../lib/util.mjs';
import {routeTyped} from './router/typed.mjs';
const simple={abduce,diagnose,associate,induce,analogize,plan,simulate};
export const ROUTE_IDS=['reference','js-reference','js-oracle'];
/** `auto`: the StrategyRouter (reasoning/router) asks for the choice; on the typed path every answer carries a proof and a validity, which only the oracle produces. */
export const AUTO='auto';
/** The external strategies, each pinned to one backend; `STRATEGY_OF_BACKEND` is the inverse, used by the runtime to route `backend` lines. */
export const EXTERNAL_STRATEGIES={'prolog-tabling':'prolog','z3-smt-bounded':'z3'};
export const STRATEGY_OF_BACKEND=Object.fromEntries(Object.entries(EXTERNAL_STRATEGIES).map(([id,backend])=>[backend,id]));
export const CAPABILITIES={
 reference:{engine:'js-reference oracle (reasoning/strategies/js-reference) through reasoning/bridge',deduce:'finite-function-free-Horn',temporal:'bitemporal-view-and-interval-join',classify:'deductive-rules',abduce:'oracle-all-inclusion-minimal-explanations',diagnose:'oracle-abduction-and-test-partition',associate:'lexical-relational-recall-memory-score',induce:'bounded-candidate-pattern-evaluation',analogize:'injective-entity-mapping',plan:'oracle-uniform-cost-search',simulate:'oracle-whatif-and-causal-Horn-intervention',constraint:'finite-linear-integers',optimize:'finite-linear-integers'},
 'prolog-tabling':{deduce:'swi-prolog-tabling-checked-against-the-oracle',other:'unsupported-explicit-backend-named-no-fallback'},
 'z3-smt-bounded':{constraint:'z3-integer-constraints',optimize:'z3-plus-optimality-check',other:'unsupported-explicit-backend-named-no-fallback'}
};
const allowedKinds={deduce:['fact','observed','rule'],temporal:['fact','observed','rule'],classify:['fact','observed','rule'],constraint:[],abduce:['fact','observed','rule','hypothesis'],diagnose:['fact','observed','rule','hypothesis'],associate:['trace'],induce:['trace','pattern'],analogize:['trace','fact','hypothesis'],plan:['fact','observed','rule','action','goal'],simulate:['fact','observed','rule','hypothesis']};
export function solverAvailable(name){const cmd=name==='prolog'?(process.env.SWIPL_BIN??'swipl'):(process.env.Z3_BIN??'z3');const r=spawnSync(cmd,['--version'],{encoding:'utf8',timeout:2000,maxBuffer:65536});return !r.error&&r.status===0;}
export class ReasoningRegistry {
 constructor({availability=solverAvailable}={}){this.availability=availability;this.cache=new Map();this.strategies=new Map([[AUTO,(r)=>this.auto(r)],...ROUTE_IDS.map(id=>[id,(r)=>this.builtin(r,'reference',null)]),...Object.entries(EXTERNAL_STRATEGIES).map(([id,backend])=>[id,(r)=>this.builtin(r,id,backend)])]);}
 register(name,handler){assert(/^[a-z][a-z0-9-]*$/.test(name)&&typeof handler==='function','Invalid reasoning strategy');assert(!this.strategies.has(name),'Reasoning strategy already registered');this.strategies.set(name,handler);return this;}
 available(name){if(!this.cache.has(name))this.cache.set(name,this.availability(name));return this.cache.get(name);}
 run(name,request){const fn=this.strategies.get(name);assert(fn,'Unknown reasoning strategy '+name);const out=fn(request);assert(out&&typeof out.status==='string'&&typeof out.complete==='boolean','Invalid reasoning result');return {...out,reasoningStrategy:name===AUTO?(out.reasoningStrategy??'reference'):ROUTE_IDS.includes(name)?'reference':name};}
 /** `reasoning auto` on the typed path. An explicit backend is honoured through the strategy of that backend (rule 8); otherwise the router decides and reports `route`. */
 auto(request){
  const requested=request.backend??'auto';
  if(!['auto','js'].includes(requested)){const id=STRATEGY_OF_BACKEND[requested];if(!id)return this.builtin({...request,backend:requested},'reference',null);return {...this.builtin(request,id,requested),reasoningStrategy:id};}
  const out=this.builtin(request,'reference',null),decision=routeTyped(request);
  return {...out,route:{...out.route,...decision}};
 }
 /** `strategy`: the id reported in the result; `pinned`: the one external backend this strategy runs (null for the JS oracle). */
 builtin(request,strategy,pinned){
  const mode=request.mode??'deduce',limits={...OPERATION_LIMITS,...request.limits},items=flat(request.data);
  const allInputs=[...items,...flat(request.candidates),...flat(request.actions),...flat(request.intervention),...flat(request.source),...flat(request.target)];
  const rejected=(code,detail,requested)=>unsupported(code,detail);
  const post=(value,requested)=>({...value,ignored:value.ignored??[],reasoningStrategy:strategy,route:{operation:mode,backend:requested,fallback:null,semantics:'explicit-request-rejected-without-substitution'}});
  const requiredConstraint=items.find(x=>x.kind==='constraint');if(requiredConstraint&&mode!=='constraint')return post(rejected('mixed_constraints_require_explicit_stage','This operation cannot drop a constraint; link a numeric solve through SOP output ports.'),'none');
  const theory=allInputs.find(x=>x.kind==='theory');if(theory)return post(rejected('unsupported_theory','No registered compiler for required dialect '+theory.dialect),'none');
  const ignored=items.filter(x=>!(allowedKinds[mode]??[]).includes(x.kind)&&x.kind!=='retrieval').map(x=>({id:x.id,kind:x.kind,reason:['pattern','hypothesis','trace'].includes(x.kind)?'not-admitted-as-deductive-evidence':'not-used-by-this-operation'}));
  let out,backend=request.backend??'auto';
  const reject=(code,detail,requested=backend)=>post(rejected(code,detail),requested);
  if(!pinned&&!['auto','js'].includes(backend))return reject('reference_backend_mismatch','The reference strategy uses JS only; name the backend '+backend+' through its strategy ('+(STRATEGY_OF_BACKEND[backend]??'none registered')+').',backend);
  if(pinned&&!['auto',pinned].includes(backend))return reject('backend_strategy_mismatch','Strategy '+strategy+' runs only the '+pinned+' backend; the request names '+backend+'.',backend);
  if(pinned)backend=pinned;
  if(['deduce','temporal','classify'].includes(mode)){
   if(backend==='auto')backend='js';
   if(!['js','prolog'].includes(backend))return reject('backend_profile_mismatch','Horn query requires JS or Prolog backend',backend);
   if(backend==='prolog'&&request.query.at===undefined)return reject('explicit_backend_not_available_for_query','The Prolog backend answers point-in-time queries; interval answers are the JS backend\'s.',backend);
   const k=partitions(request.data,request.memory,request.query),memory={facts:k.facts,rules:k.rules,complete:k.complete,probes:request.memory?.probes??0};
   const options={...limits,assumptions:request.assumptions??[]};
   out=solveHorn(request.query,memory,{...options,backend});
  }else if(mode==='constraint'){
   if(backend==='auto')backend='js';
   if(!['js','z3'].includes(backend))return reject('backend_profile_mismatch','Numeric constraints need JS or Z3',backend);
   const p=request.problem,project=request.project??[];
   if(backend==='js'&&assignmentsOf(p)===Infinity)return reject('finite_domain_required','Reference numeric reasoning requires finite integer domains',backend);
   const o={...limits,project};
   out=p.task==='optimize'?optimize(p,{...o,backend}):solveConstraint(p,{...o,backend});
  }else{
   const run=simple[mode];assert(run,'Unsupported reasoning mode '+mode);
   if(!['auto','js'].includes(backend))return reject('explicit_backend_not_available_for_mode','Mode '+mode+' is implemented only by the shared JS search controller; remove backend '+backend+'.',backend);
   const call={...request,...limits};delete call.mode;if(request.operationMode)call.mode=request.operationMode;out=run(call);backend='js';
  }
  return {...out,ignored:[...ignored,...(out.ignored??[])],route:{operation:mode,backend,fallback:null,semantics:'no-required-constraint-silently-dropped'}};
 }
}
