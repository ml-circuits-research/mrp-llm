import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {context,queryProgram,solverSkip} from '../helpers.mjs';
import {solveHorn} from '../../reasoning/bridge/solve.mjs';

const swi=solverSkip('prolog');

test('temporal Prolog export requires explicit date',()=>{
 const cli=fileURLToPath(new URL('../../server/cli.mjs',import.meta.url));
 const file=fileURLToPath(new URL('../fixtures/bootstrap.sop',import.meta.url));
 const r=spawnSync(process.execPath,[cli,'compile-prolog','--file',file],{encoding:'utf8'});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/requires --at/);
});

test('SWI portable Horn result agrees with JS',{skip:swi},async()=>{
 const c=context();
 try{
  const r=await c.run(queryProgram('grandmother ana carina')+'\n  backend prolog');
  assert.equal(r.result.status,'supported');
  assert.equal(r.result.backend,'prolog');
  assert.equal(r.result.backendAgreement,true);
 }finally{c.dispose();}
});

test('SWI support under an assumption stays conditional and does not contaminate later queries',{skip:swi},()=>{
 const atom={p:'ready',a:['sample'],neg:false},q={where:[atom],filters:[],select:[],limit:100,mode:'exists',at:0};
 const memory={facts:[],rules:[],complete:true},assumptions=[{id:'hypothesis_probe',atom,valid:{from:-Infinity,until:Infinity}}];
 const conditional=solveHorn(q,memory,{backend:'prolog',assumptions});
 assert.equal(conditional.status,'supported');
 assert.equal(conditional.backendAgreement,true);
 assert.equal(conditional.hypothetical,true);
 const ordinary=solveHorn(q,memory,{backend:'prolog'});
 assert.equal(ordinary.status,'unknown');
 assert.equal(ordinary.hypothetical,false);
});
