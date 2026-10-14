#!/usr/bin/env node
import {RecallMemory} from '../memory/weaver.mjs';

const hot={p:'likes',a:['ana','alpha'],neg:false};
const cold={p:'likes',a:['ana','beta'],neg:false};
const w=new RecallMemory({power:14,arity:3,verification:'receipt'});

w.add(hot,{strength:1,touchedAt:1});
w.add(cold,{strength:1,touchedAt:1});
for(let i=0;i<4;i++)w.reinforce(hot,{strength:1,touchedAt:2+i,reason:'proof-use'});

const firstView=0,hotAddress=w.addresses(hot)[firstView],coldAddress=w.addresses(cold)[firstView];
console.log('before cooling',{
 occupancy:w.occupancy(),
 hotCounter:w.get(firstView,hotAddress),
 coldCounter:w.get(firstView,coldAddress),
 hotReceipts:w.receipts[w.recall(hot).rows[0]?.id]?.strength??null,
 coldReceipts:w.receipts[w.recall(cold).rows[0]?.id]?.strength??null
});

w.decay(2,{at:10});
console.log('after 2 cooling steps',{
 occupancy:w.occupancy(),
 hotCounter:w.get(firstView,hotAddress),
 coldCounter:w.get(firstView,coldAddress),
 hotRecoverable:w.recall(hot).rows.length===1,
 coldRecoverable:w.recall(cold).rows.length===1,
 receipts:Object.keys(w.receipts).length
});

for(let i=0;i<1800;i++)w.add({p:'seen_with',a:['s'+i,'o'+i],neg:false},{strength:1,touchedAt:20+i});
const before=w.occupancy();
const maintenance=w.maintain({mode:'adaptive',safeOccupancy:.08,targetOccupancy:.05,step:1,maxSweeps:6,at:9999});
console.log('pressure maintenance',{before,...maintenance,hotStillRecoverable:w.recall(hot).rows.length===1});
