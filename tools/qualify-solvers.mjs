#!/usr/bin/env node
/** Executable, bounded solver qualification of the explicit backends: `prolog` is the prolog-tabling strategy, `z3` the z3-smt-bounded strategy, `js` the js-reference oracle. No model evaluation or cross-domain ranking. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {solveHorn,solveConstraint,optimize} from '../reasoning/bridge/solve.mjs';
import {ReasoningRegistry} from '../reasoning/registry.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const timeless={from:-Infinity,until:Infinity};
const atom=(p,a,neg=false)=>({p,a:Array.isArray(a)?a:[a],neg});
const fact=(id,p,a,neg=false,valid=timeless)=>({id,kind:'observed',atom:atom(p,a,neg),valid});
const rule=(id,body,head)=>({id,kind:'rule',if:body,then:head,valid:timeless});
const query=(a,{at=5,mode='exists',select=[],limit=100}={})=>({where:[a],filters:[],select,limit,mode,at});
const parent=[fact('p1','parent',['ana','bogdan']),fact('p2','parent',['bogdan','carina'])];
const ancestry=[rule('base',[atom('parent',['?x','?y'])],atom('ancestor',['?x','?y'])),rule('step',[atom('parent',['?x','?y']),atom('ancestor',['?y','?z'])],atom('ancestor',['?x','?z']))];
const hornCases=[
 {id:'recursion',facts:parent,rules:ancestry,q:query(atom('ancestor',['ana','carina'])),expected:'supported'},
 {id:'variables-output',facts:parent,rules:ancestry,q:query(atom('ancestor',['ana','?who']),{mode:'select',select:['?who']}),expected:'supported',bindings:['bogdan','carina']},
 {id:'explicit-negation',facts:[fact('n1','ready','unit',true)],rules:[],q:query(atom('ready','unit')),expected:'refuted'},
 {id:'time-in-range',facts:[fact('t1','open','gate',false,{from:0,until:10})],rules:[],q:query(atom('open','gate')) ,expected:'supported'},
 {id:'time-out-of-range',facts:[fact('t1','open','gate',false,{from:0,until:10})],rules:[],q:query(atom('open','gate'),{at:15}),expected:'unknown'},
 {id:'contradiction',facts:[fact('c1','ready','unit'),fact('c2','ready','unit',true)],rules:[],q:query(atom('ready','unit')),expected:'both'},
 {id:'hypothesis',facts:[],rules:[],q:query(atom('ready','unit')),assumptions:[{...fact('h1','ready','unit'),kind:'assumed'}],expected:'supported',hypothetical:true},
 {id:'defeated-hypothesis',facts:[fact('c2','ready','unit',true)],rules:[],q:query(atom('ready','unit')),assumptions:[{...fact('h1','ready','unit'),kind:'assumed'}],expected:'refuted',hypothetical:false},
 {id:'fact-limit',facts:parent,rules:ancestry,q:query(atom('ancestor',['ana','carina'])),limits:{maxFacts:2},expected:'unknown',complete:false}
];
const cmp=(op,a,b)=>({op,a:[a,b]});
const numericCases=[
 {id:'sat-not-entailment',p:{vars:{x:{sort:'Int',min:0,max:2}},constraints:[],claim:cmp('eq','x',1),task:'possible'},js:'possible',z3:'possible',checks:{base:'sat',withClaim:'sat',withNegatedClaim:'sat'}},
 {id:'same-claim-not-entailed',p:{vars:{x:{sort:'Int',min:0,max:2}},constraints:[],claim:cmp('eq','x',1),task:'prove'},js:'unknown',z3:'unknown',checks:{base:'sat',withClaim:'sat',withNegatedClaim:'sat'}},
 {id:'entailed',p:{vars:{x:{sort:'Int',min:1,max:1}},constraints:[],claim:cmp('eq','x',1),task:'prove'},js:'entailed',z3:'entailed',checks:{base:'sat',withClaim:'sat',withNegatedClaim:'unsat'}},
 {id:'unsat-base',p:{vars:{x:{sort:'Int',min:0,max:2}},constraints:[cmp('gt','x',1),cmp('lt','x',1)],claim:cmp('eq','x',1),task:'prove'},js:'inconsistent',z3:'inconsistent',checks:{base:'unsat'}}
];
const optimum={vars:{x:{sort:'Int',min:0,max:2},y:{sort:'Int',min:0,max:2}},constraints:[],claim:cmp('eq',cmp('add','x','y'),2),task:'optimize',objective:cmp('add','x','y'),direction:'max'};
function timed(fn){const start=performance.now();const result=fn();return {result,elapsedMs:Number((performance.now()-start).toFixed(3))};}
function summary(r){return {status:r.status,backend:r.backend,complete:r.complete,proofIds:r.proof?.map(p=>p.id),answers:r.answers?.map(a=>a.binding),hypothetical:r.hypothetical,defeatedAssumptions:r.defeatedAssumptions,backendAgreement:r.backendAgreement,proofBackend:r.proofBackend,checks:r.checks,outputProjection:r.outputProjection,objective:r.objective,optimalityCheck:r.optimalityCheck,route:r.route};}
function available(bin,args){const probe=spawnSync(bin,args,{encoding:'utf8',timeout:5000});return {available:probe.status===0,version:probe.status===0?probe.stdout.trim():null,error:probe.error?.code??(probe.status===0?null:'nonzero exit')};}
export function qualify({out=path.join(root,'eval/reports/current/solvers/qualification.json')}={}){
 const command='node tools/qualify-solvers.mjs --out '+path.relative(root,out);
 const bins={swi:{command:process.env.SWIPL_BIN??'swipl',...available(process.env.SWIPL_BIN??'swipl',['--version'])},z3:{command:process.env.Z3_BIN??'z3',...available(process.env.Z3_BIN??'z3',['-version'])}};
 const report={schema:1,command,method:'Single observed runs; elapsedMs is local wall-clock observation, not a benchmark. The oracle answer and the prolog-tabling route are separately timed; the route is measured end-to-end.',binaries:bins,reference:[],swi:[],z3:[],routing:[],unsupported:[]};
 for(const c of hornCases){
  const memory={facts:c.facts,rules:c.rules,complete:true};
  const js=timed(()=>solveHorn(c.q,memory,{backend:'js',assumptions:c.assumptions??[],...c.limits}));
  assert.equal(js.result.status,c.expected,c.id+' JS');assert.equal(js.result.backend,'js');
  if(c.complete!==undefined)assert.equal(js.result.complete,c.complete);
  if(c.bindings)assert.deepEqual(js.result.answers.map(a=>a.binding['?who']).sort(),c.bindings);
  if(c.hypothetical!==undefined)assert.equal(js.result.hypothetical,c.hypothetical);
  report.reference.push({cell:c.id,command,query:c.q,facts:c.facts.map(x=>x.id),rules:c.rules.map(x=>x.id),limits:c.limits??{},result:summary(js.result),elapsedMs:js.elapsedMs});
  if(!bins.swi.available){report.swi.push({cell:c.id,status:'skipped',reason:'SWI binary unavailable',command});continue;}
  const adapter=timed(()=>solveHorn(c.q,memory,{backend:'prolog',assumptions:c.assumptions??[],...c.limits}));
  assert.equal(adapter.result.status,c.expected,c.id+' SWI');assert.equal(adapter.result.backend,'prolog');assert.equal(adapter.result.proofBackend,'js-reference-derivation-checked-against-prolog-tabling');
  assert.equal(adapter.result.hypothetical,js.result.hypothetical);
  if(c.complete!==undefined)assert.equal(adapter.result.complete,c.complete);
  if(c.bindings)assert.deepEqual(adapter.result.answers.map(a=>a.binding['?who']).sort(),c.bindings);
  if(adapter.result.complete)assert.equal(adapter.result.backendAgreement,true,c.id+' agreement');
  report.swi.push({cell:c.id,command,query:c.q,result:summary(adapter.result),costMs:{oracle:js.elapsedMs,composedAdapter:adapter.elapsedMs}});
 }
 for(const c of numericCases){
  const js=timed(()=>solveConstraint(c.p,{backend:'js'}));assert.equal(js.result.status,c.js,c.id+' JS');
  report.reference.push({cell:c.id,command,problem:c.p,result:summary(js.result),elapsedMs:js.elapsedMs});
  if(!bins.z3.available){report.z3.push({cell:c.id,status:'skipped',reason:'Z3 binary unavailable',command});continue;}
  const native=timed(()=>solveConstraint(c.p,{backend:'z3'}));assert.equal(native.result.status,c.z3,c.id+' Z3');assert.equal(native.result.backend,'z3');assert.deepEqual(native.result.checks,c.checks);
  report.z3.push({cell:c.id,command,problem:c.p,result:summary(native.result),elapsedMs:native.elapsedMs});
 }
 const jsOpt=timed(()=>optimize(optimum,{backend:'js',project:[{name:'x',mode:'one'}]}));
 assert.equal(jsOpt.result.status,'optimal');assert.equal(jsOpt.result.objective,2);assert.equal(jsOpt.result.outputProjection['?x'].status,'ambiguous');
 report.reference.push({cell:'non-unique-optimum',command,problem:optimum,result:summary(jsOpt.result),elapsedMs:jsOpt.elapsedMs});
 if(bins.z3.available){const native=timed(()=>optimize(optimum,{backend:'z3',project:[{name:'x',mode:'one'}]}));assert.equal(native.result.status,'optimal');assert.equal(native.result.objective,2);assert.equal(native.result.optimalityCheck,'impossible');assert.equal(native.result.outputProjection['?x'].status,'ambiguous');assert.equal(native.result.backend,'z3');report.z3.push({cell:'non-unique-optimum',command,problem:optimum,result:summary(native.result),elapsedMs:native.elapsedMs});}
 else report.z3.push({cell:'non-unique-optimum',status:'skipped',reason:'Z3 binary unavailable',command});
 // Genuine Z3 resource bound, with no JS fallback. An easy problem need not actually expire.
 const timeoutProblem={vars:Object.fromEntries(Array.from({length:40},(_,i)=>['v'+i,{sort:'Int',min:0,max:1}])),constraints:[],claim:cmp('eq',Array.from({length:40},(_,i)=>'v'+i).reduce((a,b)=>cmp('add',a,b)),20),task:'prove'};
 if(bins.z3.available){const t=timed(()=>solveConstraint(timeoutProblem,{backend:'z3',timeoutMs:1}));assert.equal(t.result.backend,'z3');report.z3.push({cell:'timeout-1ms',command,problem:timeoutProblem,timeoutMs:1,result:summary(t.result),elapsedMs:t.elapsedMs,interpretation:t.result.complete?'decided-within-bound':'undecided-within-bound'});}
 else report.z3.push({cell:'timeout-1ms',status:'skipped',reason:'Z3 binary unavailable',command});
 const registry=new ReasoningRegistry();
 const req={mode:'constraint',data:[],problem:numericCases[2].p,backend:'auto'};
 {const t=timed(()=>registry.run('reference',req));assert.equal(t.result.status,'entailed');assert.equal(t.result.route.backend,'js');assert.equal(t.result.route.fallback,null);report.routing.push({cell:'reference-constraint',command,result:summary(t.result),elapsedMs:t.elapsedMs});}
 // The explicit strategies: the backend is the strategy's own, never substituted (AGENTS.md rule 8).
 if(bins.z3.available){const t=timed(()=>registry.run('z3-smt-bounded',req));assert.equal(t.result.status,'entailed');assert.equal(t.result.route.backend,'z3');assert.equal(t.result.route.fallback,null);report.routing.push({cell:'z3-strategy-constraint',command,result:summary(t.result),elapsedMs:t.elapsedMs});}
 if(bins.swi.available){const hornRoute=registry.run('prolog-tabling',{mode:'deduce',query:hornCases[0].q,data:hornCases[0].facts.concat(hornCases[0].rules),backend:'auto'});assert.equal(hornRoute.status,'supported');assert.equal(hornRoute.route.backend,'prolog');assert.equal(hornRoute.route.fallback,null);report.routing.push({cell:'prolog-strategy-horn',command,result:summary(hornRoute)});}

 const hornReference=registry.run('reference',{mode:'deduce',query:hornCases[0].q,data:hornCases[0].facts.concat(hornCases[0].rules),backend:'auto'});
 assert.equal(hornReference.status,'supported');assert.equal(hornReference.route.backend,'js');report.routing.push({cell:'reference-horn',command,result:summary(hornReference)});
 const savedZ3=process.env.Z3_BIN;try{process.env.Z3_BIN=path.join(root,'tools/.solvers/nonexistent-z3');const unavailable=registry.run('z3-smt-bounded',req);assert.equal(unavailable.status,'unsupported');assert.equal(unavailable.route.backend,'z3');assert.equal(unavailable.route.fallback,null);report.routing.push({cell:'z3-strategy-unavailable',command,result:summary(unavailable)});}finally{if(savedZ3===undefined)delete process.env.Z3_BIN;else process.env.Z3_BIN=savedZ3;}

 const noFallback=process.env.Z3_BIN;try{process.env.Z3_BIN=path.join(root,'tools/.solvers/nonexistent-z3');const missing=solveConstraint(numericCases[2].p,{backend:'z3'});assert.equal(missing.status,'unsupported');assert.equal(missing.backend,'z3');report.routing.push({cell:'explicit-z3-unavailable',command,result:summary(missing)});}finally{if(noFallback===undefined)delete process.env.Z3_BIN;else process.env.Z3_BIN=noFallback;}
 const intervalQuery={...hornCases[0].q};delete intervalQuery.at;intervalQuery.during={from:0,until:10};
 assert.throws(()=>solveHorn(intervalQuery,{facts:parent,rules:ancestry,complete:true},{backend:'prolog'}),/point-in-time/);
 const swiNumeric=registry.run('reference',{...req,backend:'prolog'});assert.equal(swiNumeric.status,'unsupported');assert.equal(swiNumeric.route.backend,'prolog');assert.equal(swiNumeric.route.fallback,null);
 assert.throws(()=>solveHorn(hornCases[0].q,{facts:parent,rules:ancestry,complete:true},{backend:'z3'}),/Horn query requires JS or Prolog/);
 const unbounded=registry.run('reference',{...req,problem:{...numericCases[2].p,vars:{x:{sort:'Int'}}}});assert.equal(unbounded.code,'finite_domain_required');
 report.unsupported=[{cell:'SWI-interval-query',status:'unsupported',command,observation:'point-in-time assertion',reason:'SWI adapter accepts only point-in-time queries; interval queries require JS'},{cell:'SWI-numeric-constraints',status:'unsupported',command,observation:swiNumeric.code,reason:'No SWI numeric constraint backend'},{cell:'Z3-Horn-proof',status:'unsupported',command,observation:'Horn backend selection assertion',reason:'No Z3 Horn compiler or independent Horn proof'},{cell:'JS-unbounded-integers',status:'unsupported',command,observation:unbounded.code,reason:'JS numeric enumerator requires finite domains'},{cell:'cross-family-global-score',status:'incomparable',command,reason:'Different supported profiles and composed SWI verification costs are incomparable'}];
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out','Usage: node tools/qualify-solvers.mjs [--out path]');
 const report=qualify({out:args.length?path.resolve(args[1]):undefined});
 console.log(JSON.stringify({report:report.command,reference:report.reference.length,swi:report.swi.length,z3:report.z3.length,routing:report.routing.length,available:{swi:report.binaries.swi.available,z3:report.binaries.z3.available}}));
}
