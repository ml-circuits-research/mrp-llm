#!/usr/bin/env node
/** Bank-level identical-corpus comparison plus repository lifecycle probes. No answer key enters recall. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBank} from '../memory/banks/factory.mjs';
import {Repository} from '../memory/repository.mjs';
import {atomKey} from '../lib/types.mjs';
import {cliArgs,digest,saveJSON} from '../lib/util.mjs';

const args=cliArgs(),out=path.resolve(args.out??new URL('../eval/reports/current/comparisons/engines.json',import.meta.url).pathname);
const counts=String(args.counts??'64,256').split(',').map(Number),seeds=String(args.seeds??'11,29').split(',').map(Number),queryCount=Number(args.queries??24);
if(!counts.every(n=>Number.isSafeInteger(n)&&n>0)||!seeds.every(Number.isSafeInteger)||!Number.isSafeInteger(queryCount)||queryCount<4)throw Error('Invalid counts, seeds or query count');
const engines=['recall-memory','holo-memory','sqlite','scan','hybrid'];
const atom=(s,v)=>({p:'rel',a:[s,v],neg:false});
const config=(engine,seed=11)=>({engine,power:12,seed,verification:'receipt',holoMemory:{rows:256,banks:4,dimension:64,seed,ageStepsPerNovel:0},retention:{mode:'none'},sharding:{enabled:true,mode:'archive',maxClaimsPerShard:3,gcEveryWrites:0}});
const pct=(list,p)=>{const sorted=[...list].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??null;};
const valid={from:-Infinity,until:Infinity};
function benchmark(engine,count,seed){
 const corpus=Array.from({length:count},(_,i)=>atom('entity_'+(i%Math.max(4,Math.floor(count/8))),'value_'+(i+seed)));
 const subjects=[...new Set(corpus.map(x=>x.a[0]))],queries=[];
 for(const distribution of ['uniform','hotspot'])for(let i=0;i<queryCount;i++)queries.push({distribution,pattern:atom(distribution==='hotspot'?subjects[i%4]:subjects[(i*17+seed)%subjects.length],'?v')});
 queries.push({distribution:'absent',pattern:atom('missing','?v')});
 const truth=new Map();for(const a of corpus){const k=a.a[0];if(!truth.has(k))truth.set(k,new Set());truth.get(k).add(atomKey(a));}
 const opts={maxProbes:count*2,maxResults:count+1,limit:count+1},bank=createBank(config(engine,seed));
 try{
  const build=performance.now();for(const a of corpus)bank.add(a,{strength:1});const buildMs=performance.now()-build;
  const samples=[];let hintCalls=0,hintRows=0,hintPromoted=0,hintProbes=0,changedTop=0;
  for(const [index,q] of queries.entries()){
   const start=performance.now();let hints=null;
   if(engine==='hybrid'){hints=bank.hints(q.pattern,opts);hintCalls++;hintRows+=hints.rows.length;hintProbes+=hints.probes;}
   const result=bank.recall(q.pattern,opts);
   // Hints affect consumer ranking only: every returned item remains exact-verified.
   const hinted=new Set(hints?.rows.map(row=>atomKey(row.atom))??[]);
   const ordered=engine==='hybrid'?[...result.rows].sort((a,b)=>Number(hinted.has(atomKey(b.atom)))-Number(hinted.has(atomKey(a.atom)))):result.rows;
   hintPromoted+=ordered.filter(row=>hinted.has(atomKey(row.atom))).length;
   changedTop+=+(ordered[0]?.id!==result.rows[0]?.id);
   const ms=performance.now()-start,expected=truth.get(q.pattern.a[0])??new Set(),got=new Set(ordered.map(row=>atomKey(row.atom)));
   const tp=[...got].filter(k=>expected.has(k)).length;
   const exactOnlyStart=performance.now();if(engine==='hybrid')bank.recall(q.pattern,opts);const exactOnlyMs=engine==='hybrid'?performance.now()-exactOnlyStart:null;
   samples.push({distribution:q.distribution,temperature:index?'warm':'cold',pattern:q.pattern,returnedKeys:[...got].sort(),expectedKeys:[...expected].sort(),expected:expected.size,returned:got.size,tp,fp:got.size-tp,fn:expected.size-tp,complete:result.complete,probes:result.probes,ms,...(hints?{hintCandidates:hinted.size,hintHits:ordered.filter(row=>hinted.has(atomKey(row.atom))).length,hintProbes:hints.probes,exactOnlyMs,topChanged:ordered[0]?.id!==result.rows[0]?.id}: {})});
  }
  const snapshot=bank.export(),reopened=createBank({},snapshot);
  let restartAgreement;try{restartAgreement=queries.every(q=>digest(bank.recall(q.pattern,opts).rows.map(r=>atomKey(r.atom)).sort())===digest(reopened.recall(q.pattern,opts).rows.map(r=>atomKey(r.atom)).sort()));}finally{reopened.close?.();}
  const stats=bank.stats(),summary=Object.fromEntries(['uniform','hotspot','absent'].map(distribution=>{const s=samples.filter(x=>x.distribution===distribution),warm=s.filter(x=>x.temperature==='warm');return [distribution,{queries:s.length,exactSets:s.filter(x=>!x.fp&&!x.fn).length,tp:s.reduce((n,x)=>n+x.tp,0),fp:s.reduce((n,x)=>n+x.fp,0),fn:s.reduce((n,x)=>n+x.fn,0),coldMs:s.find(x=>x.temperature==='cold')?.ms??null,warmMedianMs:pct(warm.map(x=>x.ms),.5),warmP95Ms:pct(warm.map(x=>x.ms),.95),medianProbes:pct(s.map(x=>x.probes),.5)}];}));
  return {engine,count,seed,corpusHash:digest(corpus),queriesHash:digest(queries),node:process.version,budget:{maxProbes:opts.maxProbes,maxResults:opts.limit,power:12,holoRows:256},buildMs,stats,snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot)),restartAgreement,hintConsumer:engine==='hybrid'?{operation:'rank exact-verified rows ahead when associative hints match',calls:hintCalls,candidates:hintRows,exactRowsPromoted:hintPromoted,changedTop,probes:hintProbes}:null,summary,samples};
 }finally{bank.close?.();}
}
function lifecycle(engine){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'comparison-lifecycle-')),memory=config(engine),r=new Repository(root,{memory}),fact=(s,retention='normal')=>({kind:'fact',atom:atom(s,'v'),valid,source:'comparison',retention});
 const has=(repo,session,s,asof=Infinity)=>repo.recall(session,atom(s,'v'),{asof,maxProbes:10000,limit:100}).rows.length>0;
 try{
  r.init('base');const a=r.session('base','alice','original'),bob=r.session('base','bob','independent');
  const [id]=r.apply(a,[fact('normal'),fact('pinned','pinned')],{knownAt:1});
  const isolationBeforeCommit=!has(r,bob,'normal');r.commit(a);
  const sameUser=r.session('base','alice','later'),isolationAfterCommit=!has(r,bob,'normal')&&has(r,sameUser,'normal');
  r.fork('base','branch');const branch=r.session('branch','alice','branch');const forkIsolation=!has(r,branch,'normal');
  r.apply(sameUser,[{kind:'event',action:'retract',target:id}],{knownAt:3});
  const retractionHistorical=has(r,sameUser,'normal',2),retractionCurrent=!has(r,sameUser,'normal',3);
  r.commit(sameUser);r.pinSnapshot('old',a.userHead);
  const checkpoint=r.checkpointBase('base'),gcWhilePinned=r.gc();
  r.closeSession(a);r.unpinSnapshot('old');
  const gcDry=r.gc(),gcApplied=r.gc({dryRun:false});
  const restarted=new Repository(root,{memory}),again=restarted.session('base','alice','restart');
  const restartRetraction=!has(restarted,again,'normal',3),restartPinned=has(restarted,again,'pinned');
  const archiveStats=again.live.stats();
  const bounded=new Repository(path.join(root,'bounded'),{memory:{...memory,sharding:{enabled:true,mode:'bounded',maxClaimsPerShard:2,maxColdShards:1,gcEveryWrites:0}}});
  bounded.init('base');const bs=bounded.session('base','alice','bounded');bounded.apply(bs,[fact('kept','pinned')],{knownAt:1});for(let i=0;i<12;i++)bounded.apply(bs,[fact('generation_'+i)],{knownAt:i+2});
  const boundedStats=bs.live.stats();return {engine,isolationBeforeCommit,isolationAfterCommit,forkIsolation,retractionHistorical,retractionCurrent,restartRetraction,restartPinned,checkpoint:{parentsRemoved:checkpoint.parentsRemoved},gcWhilePinned,gcDry,gcApplied,archive:{pinnedSurvived:restartPinned,stats:archiveStats},bounded:{normalShards:boundedStats.normalShards,pinnedSurvived:has(bounded,bs,'kept'),firstForgotten:!has(bounded,bs,'generation_0'),latestSurvived:has(bounded,bs,'generation_11'),stats:boundedStats}};
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const runs=[],lifecycles=[];for(const count of counts)for(const seed of seeds)for(const engine of engines){const result=benchmark(engine,count,seed);runs.push(result);console.log(`${engine} count=${count} seed=${seed} uniform=${result.summary.uniform.exactSets}/${queryCount} warmMedianMs=${result.summary.uniform.warmMedianMs.toFixed(3)}`);}
for(const engine of engines){const result=lifecycle(engine);lifecycles.push(result);console.log(`${engine} lifecycle: retraction=${result.restartRetraction} pinned=${result.restartPinned} boundedForgetting=${result.bounded.firstForgotten}`);}
saveJSON(out,{experiment:'engine-comparison-v1',command:'node tools/compare-engines.mjs'+(process.argv.length>2?' '+process.argv.slice(2).join(' '):''),scope:'same exact corpus/query order per count and seed; bank timings exclude repository; lifecycle separate',truthPolicy:'oracle sets confined to evaluator; retrieval receives pattern and budget only',runs,lifecycles});
console.log('Saved '+out);
