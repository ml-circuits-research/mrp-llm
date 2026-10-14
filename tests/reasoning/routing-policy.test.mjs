import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ReasoningRegistry} from '../../reasoning/registry.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {context,queryProgram,solverSkip,withEnv} from '../helpers.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const problem={kind:'constraint',vars:{x:{sort:'Int',min:0,max:2}},constraints:[],claim:{op:'le',a:['x',2]},task:'prove'};
const numeric=(reasoning='z3-smt-bounded',backend='auto')=>new ReasoningRegistry({availability:()=>false}).run(reasoning,{mode:'constraint',problem,backend});
const query={kind:'query',mode:'exists',where:[{p:'likes',a:['ana','book'],neg:false}],filters:[],select:[],limit:100,at:Date.parse('2026-09-26'),asof:Infinity};
const observed={kind:'observed',id:'f',atom:query.where[0],valid:{from:-Infinity,until:Infinity}};
const horn=(backend='prolog',registry=new ReasoningRegistry({availability:()=>false}))=>
 registry.run('prolog-tabling',{mode:'deduce',backend,query,memory:{facts:[observed],rules:[],complete:true,probes:0}});
const fact='@f fact\n  holds likes ana book\n  valid timeless\n@s remember\n  input $f';

// AGENTS.md: the entries of .agents/skills are pointers to an external catalog (the training skills moved to the frozen branch), and no skill
// introduces a second project policy file.
test('ported skills resolve by pointer to an external catalog and add no project policy',()=>{
 for(const entry of fs.readdirSync(path.join(root,'.agents/skills'),{withFileTypes:true})){
  const skill=path.join(root,'.agents/skills',entry.name);
  assert.ok(fs.lstatSync(skill).isSymbolicLink(),entry.name+' must resolve by pointer, not duplicate local rules');
  if(!fs.existsSync(skill))continue; // The external optional catalog is not required for project authority.
  const target=fs.realpathSync(skill);
  assert.ok(fs.statSync(path.join(target,'SKILL.md')).isFile(),entry.name);
  assert.equal(fs.existsSync(path.join(target,'AGENTS.md')),false,entry.name+' must not introduce project guidance');
  assert.notEqual(target,path.join(root,'skills',entry.name));
 }
 for(const entry of fs.readdirSync(path.join(root,'skills'),{withFileTypes:true})){
  if(entry.isDirectory())assert.equal(fs.existsSync(path.join(root,'skills',entry.name,'AGENTS.md')),false,entry.name);
 }
});

test('trusted reason capability advertises the conditional read effect',()=>{
 const r=spawnSync(process.execPath,[path.join(root,'tools/capabilities.mjs')],{encoding:'utf8',maxBuffer:2_000_000});
 assert.equal(r.status,0,r.stderr);
 const result=JSON.parse(r.stdout);
 assert.equal(result.wires.reason.effects,'may-reinforce-nonhypothetical-observed-proof');
 assert.equal(result.wires.remember.effects,'records-explicit-facts-and-events-in-session');
});

test('reasoning registry calculates over caller-owned facts without mutating memory',()=>{
 const memory={facts:[{kind:'observed',id:'f',atom:query.where[0],valid:{from:-Infinity,until:Infinity}}],rules:[],complete:true,probes:0,
  reinforce(){throw Error('registry must not reinforce');}};
 const previous=JSON.stringify(memory);
 const answer=new ReasoningRegistry({availability:()=>false}).run('reference',{query,memory});
 assert.equal(answer.status,'supported');assert.equal(answer.route.backend,'js');
 assert.equal(JSON.stringify(memory),previous);
});

test('reference rejects external backends; an external strategy rejects another backend; neither substitutes JS',()=>{
 const denied=numeric('reference','z3');
 assert.equal(denied.status,'unsupported');assert.equal(denied.code,'reference_backend_mismatch');
 assert.equal(denied.route.backend,'z3');assert.equal(denied.route.fallback,null);
 const mismatch=numeric('z3-smt-bounded','prolog');
 assert.equal(mismatch.status,'unsupported');assert.equal(mismatch.code,'backend_strategy_mismatch');
 assert.equal(mismatch.route.backend,'prolog');assert.equal(mismatch.route.fallback,null);
 assert.throws(()=>numeric('advanced'),/Unknown reasoning strategy advanced/,'the deprecated advanced route was removed');
});

test('explicit external backends are rejected on JS-only controller modes',()=>{
 for(const mode of ['abduce','diagnose','associate','induce','analogize','plan','simulate']){
  const requested=mode==='abduce'?'z3':'prolog';
  const result=new ReasoningRegistry({availability:()=>false}).run(requested==='z3'?'z3-smt-bounded':'prolog-tabling',{mode,backend:requested});
  assert.equal(result.status,'unsupported',mode);
  assert.equal(result.code,'explicit_backend_not_available_for_mode',mode);
  assert.equal(result.route.backend,requested,mode+' must retain the explicitly requested backend');
  assert.equal(result.route.fallback,null,mode);
 }
});

test('explicit missing Z3 and SWI never route to JS',()=>withEnv('Z3_BIN',path.join(root,'missing-z3-rp'),()=>withEnv('SWIPL_BIN',path.join(root,'missing-swipl-rp'),()=>{
 const n=numeric('z3-smt-bounded','z3');
 assert.equal(n.status,'unsupported');assert.equal(n.code,'backend_unavailable');
 assert.equal(n.backend,'z3');assert.equal(n.route.backend,'z3');assert.equal(n.route.fallback,null);
 const h=horn('prolog');
 assert.equal(h.status,'unsupported');assert.equal(h.code,'backend_unavailable');
 assert.equal(h.route.backend,'prolog');assert.equal(h.route.fallback,null);
})));

test('trusted circuit reports the external strategy that its explicit backend selects',()=>withEnv('Z3_BIN',path.join(root,'missing-z3-rp'),async()=>{
 const source='@c constraint\n  var ?x int 0 2\n  claim ?x <= 2\n@r solve\n  constraint $c\n  backend z3';
 const x=await new Runtime().run(source);
 assert.equal(x.result.reasoningStrategy,'z3-smt-bounded');
 assert.equal(x.result.status,'unsupported');
 assert.equal(x.result.code,'backend_unavailable');
 assert.equal(x.result.route.backend,'z3');assert.equal(x.result.route.fallback,null);
 const denied=await new Runtime().run(source+'\n  reasoning reference');
 assert.equal(denied.result.reasoningStrategy,'reference');
 assert.equal(denied.result.status,'unsupported');assert.equal(denied.result.code,'reference_backend_mismatch');
 assert.equal(denied.result.route.backend,'z3');assert.equal(denied.result.route.fallback,null);
}));

test('incompatible explicit Prolog interval query fails rather than selecting JS',async()=>{
 const source='@q query\n  where likes ana book\n  during 2026-09-01 2026-10-01\n@r reason\n  query $q\n  backend prolog';
 const x=await new Runtime().run(source);
 assert.equal(x.result.status,'unsupported');assert.equal(x.result.code,'explicit_backend_not_available_for_query');
 assert.equal(x.result.route.backend,'prolog');assert.equal(x.result.route.fallback,null);
});

for(const [name,solver,run] of [
 ['Z3','z3',()=>new ReasoningRegistry().run('z3-smt-bounded',{mode:'constraint',backend:'z3',problem})],
 ['SWI','prolog',()=>horn('prolog',new ReasoningRegistry())]
])test(name+' uses the real explicitly configured binary when available',{skip:solverSkip(solver)},()=>{
 const r=run();
 assert.notEqual(r.status,'unsupported');
 assert.equal(r.route.backend,solver);
 assert.equal(r.route.fallback,null);
});

test('candidate retrieval, hypothetical proof, and host read-only policy do not reinforce evidence',async()=>{
 const c=context({bootstrap:false,memory:{power:16,arity:3,retention:{reinforceOnUse:true,writeStrength:1,useStrength:2}}});
 try{
  await c.run(fact);
  const original=c.repo.reinforce.bind(c.repo);let calls=0;
  c.repo.reinforce=(...args)=>{calls++;return original(...args);};
  const recall=await c.run('@q query\n  where likes ana book\n@m recall\n  query $q');
  assert.ok(recall.result.facts.length);assert.equal(calls,0);
  const readOnly=await c.run(queryProgram('likes ana book'),{policy:{reinforce:false}});
  assert.equal(readOnly.result.status,'supported');assert.equal(readOnly.result.reinforcement,undefined);assert.equal(calls,0);
  const absent=await c.run(queryProgram('likes ana missing'));
  assert.equal(absent.result.status,'unknown');assert.equal(calls,0);
  const assumed=await c.run('@p fact\n  holds likes ana pen\n  valid timeless\n  source assumption\n@rule rule\n  when likes ana book\n  when likes ana pen\n  then likes ana set\n@q query\n  where likes ana set\n@m link\n  query $q\n  data $rule\n@r reason\n  query $q\n  memory $m\n  assume $p');
  assert.equal(assumed.result.status,'supported');assert.equal(assumed.result.hypothetical,true);
  assert.equal(assumed.result.reinforcement,undefined);
  assert.equal(calls,0);
 }finally{c.dispose();}
});

test('a permitted verified observed proof declares any promotion in its result',async()=>{
 const c=context({bootstrap:false,memory:{power:16,arity:3,retention:{reinforceOnUse:true,writeStrength:1,useStrength:2}}});
 try{
  await c.run(fact);
  const x=await c.run(queryProgram('likes ana book'));
  assert.equal(x.result.status,'supported');
  assert.ok(x.result.reinforcement?.facts>0);
  assert.equal(x.result.reinforcement.strength,2);
 }finally{c.dispose();}
});

test('retention disables proof-use promotion even when host policy permits it',async()=>{
 const c=context({bootstrap:false,memory:{power:16,arity:3,retention:{reinforceOnUse:false,writeStrength:1,useStrength:2}}});
 try{
  await c.run(fact);
  const x=await c.run(queryProgram('likes ana book'));
  assert.equal(x.result.status,'supported');assert.equal(x.result.reinforcement,undefined);
 }finally{c.dispose();}
});
