import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../../sop/runtime.mjs';
import {parse,validateGraph} from '../../sop/parser.mjs';
import {context,solverSkip} from '../helpers.mjs';

const query=(select='?who',where='grandmother ?who carina')=>`@q query\n  select ${select}\n  where ${where}\n  at 2026-09-26\n`;
const solve=(outputs='?who one')=>`@r solve\n  query $q\n  output ${outputs}\n`;
const answer='@answer cnl\n  result $r\n  language ro';
const indent=body=>body.split('\n').map(l=>'    '+l).join('\n');
async function withContext(fn,options){const c=context(options);try{return await fn(c);}finally{c.dispose();}}

test('deferred output is legal without @who declaration',()=>{
 assert.ok(validateGraph(parse(query()+solve()+'@s jsEval\n  expr $who')));
});
test('unknown dollar reference without a producer is an error',()=>{
 assert.throws(()=>validateGraph(parse('@s jsEval\n  expr $missing')),/Unknown reference/);
});
test('duplicate output producers are rejected',()=>{
 assert.throws(()=>validateGraph(parse(query()+solve()+'@r2 solve\n  query $q\n  output ?who one')),/Multiple producers/);
});
test('output cannot overwrite an explicit wire',()=>{
 assert.throws(()=>validateGraph(parse('@who value\n  data "fixed"\n'+query()+solve())),/conflicts/);
});
test('deferred output cycle is caught before executing',()=>{
 assert.throws(()=>validateGraph(parse(query('?who','parent ?who $who')+solve())),/Cyclic/);
});
test('unselected output variable is not inferred by name',()=>withContext(async c=>{
 await assert.rejects(c.run(query()+solve('?other one')),/selected\/declared/);
}));
test('runtime generates and consumes a scalar output',()=>withContext(async c=>{
 const r=await c.run(query()+solve()+'@s jsEval\n  expr "answer: " + $who');
 assert.equal(r.result,'answer: ana');
 assert.equal(r.outputs.who.status,'bound');
 assert.ok(r.generated.some(g=>g.source.includes('@who binding')));
 assert.ok(r.trace.find(t=>t.type==='binding'));
}));
test('output dependencies work regardless of declaration order',()=>withContext(async c=>{
 const r=await c.run('@s jsEval\n  expr $who\n'+query()+solve()+answer);
 assert.equal(r.values.s,'ana');
}));
test('many answers are not silently collapsed to a scalar',()=>withContext(async c=>{
 const r=await c.run(query('?who','ancestor ?who carina')+solve()+'@s jsEval\n  expr $who\n'+answer);
 assert.equal(r.outputs.who.status,'ambiguous');
 assert.equal(r.blocked.s.status,'blocked');
 assert.equal(r.result.packet.status,'supported');
 assert.equal(Object.hasOwn(r.values,'who'),false);
}));
test('many output intentionally returns the candidate set',()=>withContext(async c=>{
 const r=await c.run(query('?who','ancestor ?who carina')+solve('?who many')+answer);
 assert.deepEqual(r.values.who.sort(),['ana','bogdan']);
}));
test('rows preserve associations across multiple selected columns',()=>withContext(async c=>{
 const r=await c.run(query('?p ?child','parent ?p ?child')+solve('?pairs rows')+answer);
 assert.ok(r.values.pairs.some(x=>x['?p']==='ana'&&x['?child']==='bogdan'));
 assert.ok(!r.values.pairs.some(x=>x['?p']==='ana'&&x['?child']==='carina'));
}));
test('missing answer stays unbound and blocks only descendants',()=>withContext(async c=>{
 const r=await c.run(query('?who','works_at ?who unknown_org')+solve()+'@s jsEval\n  expr $who\n'+answer);
 assert.equal(r.outputs.who.status,'no_answer');
 assert.equal(r.result.packet.status,'unknown');
 assert.equal(r.blocked.s.status,'blocked');
}));
test('incomplete retrieval cannot materialize one answer',()=>withContext(async c=>{
 const r=await c.run(query()+solve()+answer,{policy:{maxProbes:1}});
 assert.equal(r.outputs.who.status,'incomplete');
}));
test('explicit opposite evidence blocks selected scalar',()=>withContext(async c=>{
 const r=await c.run(`@negative fact
  holds not grandmother ana carina
  valid timeless
@put remember
  input $negative
`+query()+`@r solve
  query $q
  output ?who one
  after $put
`+answer);
 assert.equal(r.outputs.who.status,'conflict');
}));
test('a status output can be used even when no fact is known',()=>withContext(async c=>{
 const r=await c.run(query('?who','works_at ?who missing')+solve('?decision status')+'@s jsEval\n  expr $decision');
 assert.equal(r.result,'unknown');
}));
// A count is a closed-world answer: it needs an exact complete view (R-P2, R-P3), so it is asked of the SQLite memory.
test('count output requires a complete count query',()=>withContext(async c=>{
 const r=await c.run(query('?who','ancestor ?who carina').replace('  select','  mode count\n  select')+solve('?total count')+'@s jsEval\n  expr $total');
 assert.equal(r.result,2);
},{memory:{engine:'sqlite'}}));
test('a count over an associative memory is withheld, never given as exact (R-P3)',()=>withContext(async c=>{
 const r=await c.run(query('?who','ancestor ?who carina').replace('  select','  mode count\n  select')+solve('?total count')+'@s jsEval\n  expr $total');
 assert.equal(r.values.r.status,'incomplete');
 assert.equal(r.values.r.reason,'partial_retrieval');
 assert.equal(r.values.r.at_least,2);
 assert.deepEqual(r.values.r.retrieval_reasons,['inexact_view']);
 assert.equal(r.blocked.s.status,'blocked');
}));
test('query output used to formulate a second memory query',()=>withContext(async c=>{
 const r=await c.run(query()+solve()+`@q2 query
  select ?organization
  where parent $who ?organization
  at 2026-09-26
@r2 solve
  query $q2
  output ?organization one
@answer jsEval
  expr $organization`);
 assert.equal(r.result,'bogdan');
 assert.ok(r.epochs>=3);
}));
test('template output names are hygienic across two expansions',()=>withContext(async c=>{
 const body=query()+solve()+'@final jsEval\n  expr $who';
 const sop='@t template\n  params\n  yield final\n  body |\n'+indent(body)+'\n@a expand\n  using ~t\n@b expand\n  using ~t';
 const r=await c.run(sop);
 assert.equal(r.values.a,'ana');
 assert.equal(r.values.b,'ana');
 assert.equal(r.values.a__who,'ana');
 assert.equal(r.values.b__who,'ana');
}));
test('generated bindings cannot be injected by model or user',async()=>{
 await assert.rejects(new Runtime().run('@v value\n  data 1\n@x binding\n  result $v\n  variable ?x\n  mode one\n  owner v'),/runtime-generated/);
});

const numeric=(backend='js',ambiguous=false)=>`@c constraint
  var ?arrival int 0 1440
  require ?arrival ${ambiguous?'>=':'=='} 770 + 70
  claim ?arrival <= 840
@r solve
  constraint $c
  backend ${backend}
  output ?arrival one
@answer cnl
  result $r
  language ro`;
for(const backend of ['js','z3']){
 const skip=backend==='z3'?solverSkip('z3'):false;
 test(backend+' numerical value exported only when unique',{skip},async()=>{
  const r=await new Runtime().run(numeric(backend));
  assert.equal(r.values.arrival,840);
  assert.equal(r.result.packet.status,'entailed');
  assert.equal(r.result.packet.backend,backend);
 });
 test(backend+' one model is not a unique output',{skip},async()=>{
  const r=await new Runtime().run(numeric(backend,true));
  assert.equal(r.outputs.arrival.status,'ambiguous');
  assert.equal(Object.hasOwn(r.values,'arrival'),false);
 });
}
test('finite constraint many projects all base-domain values',async()=>{
 const r=await new Runtime().run('@c constraint\n  var ?n int 1 3\n  claim ?n == 2\n  task possible\n@r solve\n  constraint $c\n  output ?n many');
 assert.deepEqual(r.values.n,[1,2,3]);
});
test('expansion budget also bounds automatic solve wiring',()=>withContext(async c=>{
 await assert.rejects(c.run(query()+solve(),{policy:{maxEpochs:0}}),/epoch budget/);
}));
test('one logical variable cannot connect incompatible predicate argument types',()=>withContext(async c=>{
 await assert.rejects(c.run(`@q query
  select ?v
  where parent ?v carina
  where works_at ana ?v
@r solve
  query $q`),/Incompatible types/);
}));
test('approved mixed template links numeric memory to constraint output',()=>withContext(async c=>{
 const r=await c.run('@route value\n  data "route_demo"\n@start value\n  data 770\n@deadline value\n  data 840\n@answer expand\n  using ~check_arrival\n  with route $route\n  with start $start\n  with deadline $deadline');
 assert.equal(r.values.answer__duration,70);
 assert.equal(r.values.answer__arrival,840);
 assert.equal(r.result.packet.status,'possible');
}));
test('template may yield a deferred output directly',()=>withContext(async c=>{
 const sop='@t template\n  yield who\n  body |\n'+indent(query()+solve())+'\n@answer expand\n  using ~t';
 const r=await c.run(sop);
 assert.equal(r.result,'ana');
}));
