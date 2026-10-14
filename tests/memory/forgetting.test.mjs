import test from 'node:test';
import assert from 'node:assert/strict';
import {RecallMemory} from '../../memory/weaver.mjs';
import {context,queryProgram} from '../helpers.mjs';

const a={p:'likes',a:['ana','alpha'],neg:false};
const b={p:'likes',a:['ana','beta'],neg:false};

test('cell-level reinforcement survives a cooling sweep while one-shot support fades',()=>{
 const w=new RecallMemory({power:16,arity:3,verification:'receipt'});
 w.add(a,{strength:1});w.add(b,{strength:1});w.reinforce(a,{strength:2});w.decay(1);
 assert.equal(w.recall(a).rows.length,1);
 assert.equal(w.recall(b).rows.length,0);
});

test('pressure maintenance cools only after the safe occupancy threshold',()=>{
 const w=new RecallMemory({power:10,arity:3,verification:'receipt'});
 for(let i=0;i<250;i++)w.add({p:'r',a:['s'+i,'o'+i],neg:false},{strength:1});
 const before=w.occupancy();
 const r=w.maintain({mode:'adaptive',safeOccupancy:.02,targetOccupancy:.01,step:1,maxSweeps:4});
 assert.ok(before>.02);assert.equal(r.triggered,true);assert.ok(r.after<r.before);
});

test('archive mode does not automatically forget under pressure',()=>{
 const w=new RecallMemory({power:10,arity:3,verification:'receipt'});
 for(let i=0;i<250;i++)w.add({p:'r',a:['s'+i,'o'+i],neg:false},{strength:1});
 const before=w.occupancy(),r=w.maintain({mode:'none',safeOccupancy:.02,targetOccupancy:.01});
 assert.equal(r.triggered,false);assert.equal(w.occupancy(),before);
});

test('only facts used by a real proof are reinforced automatically',async()=>{
 const memory={power:16,arity:3,retention:{mode:'adaptive',safeOccupancy:.99,targetOccupancy:.9,writeStrength:1,useStrength:2,decayStep:1,maxSweeps:2,reinforceOnUse:true}};
 const c=context({bootstrap:false,memory});
 try{
  await c.run('@a fact\n  holds likes ana lab_alpha\n  valid timeless\n@b fact\n  holds likes ana lab_beta\n  valid timeless\n@s remember\n  input $a $b');
  assert.equal((await c.run(queryProgram('likes ana lab_alpha'))).result.status,'supported');
  c.repo.decay(c.session,1);
  assert.equal((await c.run(queryProgram('likes ana lab_alpha'))).result.status,'supported');
  assert.equal((await c.run(queryProgram('likes ana lab_beta'))).result.status,'unknown');
 }finally{c.dispose();}
});
