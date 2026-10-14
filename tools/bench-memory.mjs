#!/usr/bin/env node
/** Reproducible backend comparison on the SAME canonical atoms and queries.
 * No LLM. Ground truth is held by the evaluator, never passed to recall().
 * Timings are bank-only; end-to-end conformance is tested separately.
 */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createBank} from '../memory/banks/factory.mjs';
import {SQLiteBank} from '../memory/banks/sqlite.mjs';
import {atomKey} from '../lib/types.mjs';
import {mix} from '../memory/banks/holo-kernel.mjs';
import {cliArgs,saveJSON,digest} from '../lib/util.mjs';
const args=cliArgs(),here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
function pct(values,p){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(p*a.length))];}
function data(n,seed){
 const atoms=[],forward=new Map(),reverse=new Map();
 for(let i=0;i<n;i++){
  const subject='entity_'+(i%11===10?i-1:i),object='value_'+(mix(i+seed)%128),a={p:'relation',a:[subject,object],neg:false};atoms.push(a);
  if(!forward.has(subject))forward.set(subject,new Map());forward.get(subject).set(atomKey(a),a);
  if(!reverse.has(object))reverse.set(object,new Map());reverse.get(object).set(atomKey(a),a);
 }
 return {atoms,forward,reverse};
}
function tasks(dataset,n,seed){
 const queries=[];const subjects=[...dataset.forward.keys()],objects=[...dataset.reverse.keys()];
 for(let j=0;j<n;j++){const s=subjects[mix(seed+j*701)%subjects.length];queries.push({type:'completion',pattern:{p:'relation',a:[s,'?value'],neg:false},expected:new Set(dataset.forward.get(s).keys())});}
 for(let j=0;j<Math.max(10,Math.floor(n/4));j++)queries.push({type:'absent',pattern:{p:'relation',a:['missing_'+j,'?value'],neg:false},expected:new Set()});
 // Broad reverse lookup has a large fan-out. It is a separate result category,
 // never silently mixed with the convenient small candidate-domain task.
 for(let j=0;j<2;j++){const v=objects[mix(seed+j)%objects.length];queries.push({type:'reverse',pattern:{p:'relation',a:['?entity',v],neg:false},expected:new Set(dataset.reverse.get(v).keys())});}
 return queries;
}
function worker(){
 const engine=args.worker,n=Number(args.count??10000),seed=Number(args.seed??11),power=Number(args.power??18),queryCount=Number(args.queries??80);
 if(!Number.isSafeInteger(n)||n<1||!Number.isInteger(power)||power<8||power>23)throw Error('Invalid count/power');
 const d=data(n,seed),qs=tasks(d,queryCount,seed),dir=fs.mkdtempSync(path.join(os.tmpdir(),'recall-bench-'));
 const config={engine,power,arity:3,seed,verification:'receipt',holoMemory:{banks:5,rows:2**(power-5),dimension:64,seed,ageStepsPerNovel:0,minSignal:.35,minCorrelation:.15},sqlite:{fts:args.fts!=='false'}};
 const baseline=process.memoryUsage();let b;const start=performance.now();
 try{
  b=engine==='sqlite'?new SQLiteBank(config,null,{path:path.join(dir,'facts.sqlite')}):createBank(config);
  const insert=()=>{for(const a of d.atoms)b.add(a,{strength:1});};if(b.transaction)b.transaction(insert);else insert();
  const buildMs=performance.now()-start;
  // Warm the codeword/index path without using scored queries as training data.
  for(const q of qs.slice(0,5))b.recall(q.pattern,{maxProbes:n+20000,limit:n+1});
  const records=[],agg={};
  for(const q of qs){
   const t=performance.now(),r=b.recall(q.pattern,{maxProbes:n+20000,limit:n+1}),ms=performance.now()-t;
   const got=new Set(r.rows.map(x=>atomKey(x.atom)));let tp=0,fp=0;for(const k of got)if(q.expected.has(k))tp++;else fp++;
   const record={type:q.type,pattern:q.pattern,expected:q.expected.size,returned:got.size,tp,fp,fn:q.expected.size-tp,complete:r.complete,probes:r.probes,ms};records.push(record);
   agg[q.type]??={queries:0,tp:0,fp:0,fn:0,exactSets:0,budgetComplete:0,ms:[]};const x=agg[q.type];x.queries++;x.tp+=tp;x.fp+=fp;x.fn+=record.fn;x.exactSets+=+(record.fn===0&&fp===0);x.budgetComplete+=+r.complete;x.ms.push(ms);
  }
  for(const [name,x] of Object.entries(agg)){x.precision=x.tp+x.fp?x.tp/(x.tp+x.fp):null;x.recall=x.tp+x.fn?x.tp/(x.tp+x.fn):null;x.medianMs=pct(x.ms,.5);x.p95Ms=pct(x.ms,.95);delete x.ms;}
  const stats=b.stats(),beforeExport=process.memoryUsage(),ts=performance.now(),snapshot=JSON.stringify(b.export()),snapshotMs=performance.now()-ts;
  const result={engine,count:n,distinctAtoms:new Set(d.atoms.map(atomKey)).size,seed,power,config,node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,
   inputHash:digest(d.atoms),queryHash:digest(qs.map(x=>x.pattern)),buildMs,stats,snapshotBytes:Buffer.byteLength(snapshot),snapshotMs,
   processMemory:{rss:beforeExport.rss,heapUsed:beforeExport.heapUsed,heapDeltaSinceDataset:beforeExport.heapUsed-baseline.heapUsed,note:'includes JS runtime/caches; not an isolated allocator measurement'},summary:agg,queries:records,
   timingScope:'bank insertion and retrieval only; no SOP parser, temporal layer, repository snapshot per write, LLM, linker or solver',
   sqlQueryPlan:b.explain?.(qs[0].pattern)??null};
  saveJSON(args.out,result);console.log(JSON.stringify({engine,count:n,seed,buildMs,summary:agg}));
 }finally{b?.close?.();fs.rmSync(dir,{recursive:true,force:true});}
}
if(args.help){console.log('node tools/bench-memory.mjs --counts 10000,100000 --queries 80 --seeds 11,29 --engines recall-memory,holo-memory,sqlite,scan --power 18 --out eval/reports/current/memory\n--power 18 gives BOTH associative banks exactly 2.5 MiB. Metadata is extra. SQL/scan grow with the records. FTS is enabled unless --fts false.');}
else if(args.worker)worker();
else{
 const out=path.resolve(root,args.out??'eval/reports/current/memory');fs.mkdirSync(out,{recursive:true});const runs=[];
 for(const count of String(args.counts??'10000,100000').split(','))for(const seed of String(args.seeds??'11').split(','))for(const engine of String(args.engines??'recall-memory,holo-memory,sqlite,scan').split(',')){
  const file=path.join(out,`${engine}-${count}-${seed}.json`),t=performance.now();
  const r=spawnSync(process.execPath,[path.join(here,'bench-memory.mjs'),'--worker',engine,'--count',count,'--seed',seed,'--queries',String(args.queries??80),'--power',String(args.power??18),'--fts',String(args.fts??true),'--out',file],{encoding:'utf8',timeout:Number(args.timeoutMs??300000),maxBuffer:2*1024*1024});
  fs.writeFileSync(file.replace('.json','.log'),(r.stdout??'')+(r.stderr??''));
  if(r.status!==0){console.error(r.stderr||r.error);throw Error('Benchmark failed: '+engine+' '+count);}
  const data=JSON.parse(fs.readFileSync(file));runs.push({file:path.basename(file),...data,queries:undefined});console.log(engine+' '+count+' seed '+seed+' done in '+((performance.now()-t)/1000).toFixed(2)+'s');
 }
 saveJSON(path.join(out,'comparison.json'),{experiment:'sop-bank-comparison-v1',runs});
}
