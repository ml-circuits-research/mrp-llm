#!/usr/bin/env node
/** Seeded integration stress test for retention and partial fact reconstruction.
 * Ground truth stays in the evaluator, not in the memory. Both modes use receipt
 * verification and synthetic facts. Not a natural-language or Internet-scale test.
 */
import assert from 'node:assert/strict';import os from 'node:os';
import {ShardedLayer} from '../memory/sharded.mjs';import {recallLayers} from '../memory/temporal.mjs';
import {cliArgs,saveJSON} from '../lib/util.mjs';
const args=cliArgs(),N=Number(args.facts??2000),queries=Number(args.queries??200),batch=Number(args.batch??64),power=Number(args.power??10),cold=Number(args.cold??4),seed=Number(args.seed??731);
assert.ok(Number.isInteger(N)&&N>=100&&N<=100000);assert.ok(Number.isInteger(queries)&&queries>0&&queries<=N);assert.ok(Number.isInteger(batch)&&batch>0);
let randomState=seed>>>0;const random=()=>{randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;return (randomState>>>0)/4294967296;};
const sample=Array.from({length:queries},()=>Math.floor(random()*N));
const fact=i=>({kind:'fact',atom:{p:'record',a:['s_'+i,'o_'+((i*7919+17)%1000003),'ctx_'+(i%11)],neg:false},valid:{from:0,until:1000000},source:'synthetic'});
const snapshot={at:100,asof:Infinity},modes=[];
const quantile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))];
for(const mode of ['bounded','archive']){
 const config={power,arity:3,seed,verification:'receipt',retention:{writeStrength:2,useStrength:1,reinforceOnUse:true},
  sharding:{enabled:true,mode,maxClaimsPerShard:batch,maxColdShards:cold,safeOccupancy:.55,gcEveryWrites:0}};
 const memory=new ShardedLayer(config),inputIds=[];let promotions=0;
 const start=performance.now();memory.add({...fact(N+1),retention:'pinned'},{knownAt:1,at:0});
 for(let i=0;i<N;i++){
  inputIds.push(memory.add(fact(i),{knownAt:1,at:i+1}));
  if(i>0&&i%batch===0){
   const active=recallLayers([memory],fact(0).atom,snapshot,{maxProbes:1000000}).rows[0];assert.ok(active,'Useful sentinel unexpectedly forgotten');
   memory.reinforce(active,{usedAt:i+1});promotions++;
  }
 }
 const buildMs=performance.now()-start,latencies=[];let correct=0,expectedAbstentions=0,falseRows=0,probes=0,visited=0;
 const retained=new Set(Object.keys(memory.claims));
 for(const i of sample){
  const f=fact(i),pattern={...f.atom,a:[f.atom.a[0],'?value',f.atom.a[2]]},t=performance.now();
  const result=recallLayers([memory],pattern,snapshot,{maxProbes:1000000,limit:10000});latencies.push(performance.now()-t);probes+=result.probes;visited+=result.shardsVisited;
  assert.equal(result.complete,true,'Benchmark query unexpectedly exceeded a budget');
  if(retained.has(inputIds[i])){if(result.rows.length===1&&result.rows[0].atom.a[1]===f.atom.a[1])correct++;else falseRows++;}
  else if(result.rows.length===0)expectedAbstentions++;else falseRows++;
 }
 let absentFalsePositives=0;for(let i=0;i<100;i++)absentFalsePositives+=recallLayers([memory],fact(N+100+i).atom,snapshot,{maxProbes:1000000}).rows.length;
 assert.equal(falseRows,0);assert.equal(absentFalsePositives,0);
 assert.equal(recallLayers([memory],fact(0).atom,snapshot,{maxProbes:1000000}).rows.length,1);
 assert.equal(recallLayers([memory],fact(N+1).atom,snapshot,{maxProbes:1000000}).rows.length,1);
 const stats=memory.stats();if(mode==='bounded')assert.ok(stats.normalShards<=cold+1);else assert.equal(retained.size,N+1);
 modes.push({mode,insertedFacts:N,queries,correctCompletions:correct,expectedAbstentions,falseRows,absentQueries:100,absentFalsePositives,
  usefulSentinelRetained:true,pinnedRetained:true,promotions,normalShards:stats.normalShards,pinnedShards:stats.pinnedShards,
  normalBankBytes:stats.normalBankBytes,pinnedBankBytes:stats.pinnedBankBytes,metadataBytes:stats.metadataBytes,eventsBytes:stats.eventsBytes,
  retainedClaims:retained.size,evictedShards:stats.maintenance.evictedShards,
  buildMs:Number(buildMs.toFixed(3)),queryMedianMs:Number(quantile(latencies,.5).toFixed(3)),queryP95Ms:Number(quantile(latencies,.95).toFixed(3)),
  meanProbes:probes/queries,meanVisitedShards:visited/queries,peakOccupancy:Math.max(...stats.cold.map(p=>p.peakOccupancy),stats.hot?.peakOccupancy??0),
  measurements:{indices:sample,latenciesMs:latencies.map(t=>Number(t.toFixed(5)))}});
 console.log(mode+': '+correct+' recovered, '+expectedAbstentions+' intentionally absent, '+falseRows+' errors');
}
const report={experiment:'shard-retention-and-completion-v1',synthetic:true,neuralModelTested:false,seed,parameters:{facts:N,queries,batch,power,cold},
 runtime:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model},modes};
saveJSON(args.out??new URL('../eval/reports/current/shards/benchmark.json',import.meta.url),report);console.log(JSON.stringify({...report,modes:modes.map(({measurements,...r})=>r)},null,2));
