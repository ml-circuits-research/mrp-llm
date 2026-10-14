import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildMatrix,renderMatrix} from '../../tools/capability-matrix.mjs';
import {repoPath} from '../helpers.mjs';
const bank={
 experiment:'engine-comparison-v1',
 runs:[{
  engine:'recall-memory',count:8,seed:11,corpusHash:'same',queriesHash:'same',budget:{maxProbes:16,maxResults:9},
  buildMs:1,snapshotBytes:100,restartAgreement:true,hintConsumer:null,samples:[{fp:0,fn:0}],
  summary:{uniform:{exactSets:1},hotspot:{exactSets:1},absent:{exactSets:1}},stats:{banksBytes:100},
 }],
 lifecycles:[],
};
const reasoning={
 experiment:'reasoning-memory-v1',
 cells:[
  {engine:'recall-memory',backend:'js',status:'observed',reportedBackend:'js',queryStatus:'supported',complete:true},
  {engine:'recall-memory',backend:'prolog',status:'skipped',reason:'SWI unavailable'},
  {engine:'recall-memory',backend:'z3',status:'unsupported',reason:'Z3 cannot execute Horn'},
 ],
};
test('unmeasured matrix cells remain missing, not inferred from another engine or JS fallback',()=>{
 const result=buildMatrix(bank,reasoning);assert.deepEqual(result.totals,{observed:1,skipped:1,unsupported:1,missing:12});
 assert.equal(result.reasoningMatrix[0].cells[1].status,'skipped');assert.equal(result.reasoningMatrix[0].cells[2].status,'unsupported');
 assert.ok(result.reasoningMatrix.slice(1).every(row=>row.cells.every(cell=>cell.status==='missing')));
 assert.match(renderMatrix(result),/missing: No raw comparison cell/);
});
test('inconsistent workload and fabricated observed backend cannot enter matrix',()=>{
 const wrong={...bank,runs:[...bank.runs,{...bank.runs[0],engine:'sqlite',corpusHash:'other'}]};
 assert.throws(()=>buildMatrix(wrong,reasoning),/Inconsistent workload/);
 const wrongReason={...reasoning,cells:[{...reasoning.cells[0],reportedBackend:'prolog'}]};
 assert.throws(()=>buildMatrix(bank,wrongReason),/backend mismatch/);
});
test('CLI regenerates deterministic matrix and replaces stale statuses when raw input changes',()=>{
 const target=fs.mkdtempSync(path.join(os.tmpdir(),'matrix-test-'));
 const enginePath=path.join(target,'engines.json'),reasonerPath=path.join(target,'reasoners.json'),matrixPath=path.join(target,'matrix.json');
 try{
  fs.writeFileSync(enginePath,JSON.stringify(bank));fs.writeFileSync(reasonerPath,JSON.stringify(reasoning));
  const command=[repoPath('tools/capability-matrix.mjs'),'--engines',enginePath,'--reasoners',reasonerPath,'--out',matrixPath];
  const run=()=>{const result=spawnSync(process.execPath,command,{encoding:'utf8',cwd:target});assert.equal(result.status,0,result.stderr);return fs.readFileSync(matrixPath,'utf8');};
  const first=run();assert.equal(run(),first);assert.deepEqual(JSON.parse(first),buildMatrix(bank,reasoning));
  const updated={...reasoning,cells:reasoning.cells.map(c=>c.backend==='prolog'?{engine:'recall-memory',backend:'prolog',status:'observed',reportedBackend:'prolog',complete:true,queryStatus:'supported'}:c)};
  fs.writeFileSync(reasonerPath,JSON.stringify(updated));const second=run(),parsed=JSON.parse(second);
  assert.notEqual(second,first);assert.equal(parsed.totals.observed,2);assert.equal(parsed.totals.skipped,0);
  assert.equal(fs.readFileSync(path.join(target,'matrix.txt'),'utf8'),renderMatrix(parsed));
 }finally{fs.rmSync(target,{recursive:true,force:true});}
});
