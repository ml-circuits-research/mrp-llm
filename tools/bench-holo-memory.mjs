#!/usr/bin/env node
/** New HoloMemory kernel and known-handle measurements of this implementation (DS017).
 * They are not a reproduction of the historical five-seed table; DS017 lists that as a required experiment. */
import {HoloKernel,mix} from '../memory/banks/holo-kernel.mjs';
import {HoloWireMemory} from './holo-wire.mjs';
import {cliArgs,saveJSON} from '../lib/util.mjs';
const args=cliArgs(),alphabet=Array.from({length:256},(_,i)=>i),count=Number(args.count??3000),samples=Number(args.samples??300),out=args.out??new URL('../eval/reports/current/memory/holo-memory-kernel.json',import.meta.url),runs=[];
for(const seed of String(args.seeds??'11,29,53').split(',').map(Number))for(const budgetKiB of [16,32,64,128]){
 const rows=budgetKiB*1024/(4*64),k=new HoloKernel({rows,banks:4,dimension:64,seed});
 for(let i=0;i<count;i++)k.remember('item_'+i,mix(i+seed)%256,{novelty:'new'});
 for(const damage of [0,.1,.3,.5]){
  const copy=k.fork();copy.eraseFraction(damage,seed+777);let topCorrect=0,accepted=0,correctAccepted=0,wrongAccepted=0;const t=performance.now();
  for(let j=0;j<samples;j++){const i=mix(j*97+seed)%count,r=copy.read('item_'+i,alphabet),truth=mix(i+seed)%256;topCorrect+=+(r.ranked[0].value===truth);if(r.status==='remembered'){accepted++;if(r.value===truth)correctAccepted++;else wrongAccepted++;}}
  let absentAccepted=0;for(let j=0;j<50;j++)absentAccepted+=+(copy.read('absent_'+j,alphabet).status==='remembered');
  runs.push({seed,budgetKiB,count,samples,damage,topCorrect,accepted,correctAccepted,wrongAccepted,absentQueries:50,absentAccepted,ms:performance.now()-t});
 }
 console.log('kernel seed '+seed+' '+budgetKiB+' KiB done');
}
const w=new HoloWireMemory({kernel:{banks:4,rows:4096,dimension:64}}),handles=[];
for(let i=0;i<30;i++)handles.push(w.remember('@f'+i+' fact\n  holds works_at person_'+i+' org_'+i+'\n  valid timeless').handle);
const wireRuns=[];for(const damage of [0,.1,.3,.5]){const copy=w.fork();copy.kernel.eraseFraction(damage,19);let restored=0,probes=0;const t=performance.now();for(const h of handles){const r=copy.recall(h);restored+=+(r.status==='remembered');probes+=r.probes;}wireRuns.push({wires:handles.length,damage,restored,probes,ms:performance.now()-t,banksBytes:w.stats().banksBytes});}
saveJSON(out,{experiment:'holo-memory-key-value-and-known-handle-v1',node:process.version,runs,wireRuns,
 note:'Kernel acceptance has no receipt/checksum and can falsely accept an absent key. SOP fact adapter adds SHA-256 receipts; the wire plane verifies content against its handle. TopCorrect is forced rank-1 accuracy, not accepted-answer precision. Known-handle wire reads do not implement partial-cue discovery.'});
