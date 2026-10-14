import test from 'node:test';
import assert from 'node:assert/strict';
import {reason} from '../../reasoning/bridge/index.mjs';
import {solveHorn} from '../../reasoning/bridge/solve.mjs';
import {solverSkip} from '../helpers.mjs';

const swi=solverSkip('prolog');
const atom=(p,a,neg=false)=>({p,a:Array.isArray(a)?a:[a],neg});
const fact=(id,p,a,neg=false)=>({id,atom:atom(p,a,neg),valid:{from:-Infinity,until:Infinity}});
const assumption=(id,p,a,neg=false)=>({id,atom:atom(p,a,neg),valid:{from:-Infinity,until:Infinity},kind:'assumed'});
const q=(...parts)=>({where:[{p:parts[0],a:parts.slice(1),neg:false}],filters:[],select:[],limit:100,mode:'exists',at:0});
const memory=facts=>({facts,rules:[],complete:true});

test('an uncontested assumption supports the answer, but only hypothetically',()=>{
  const r=reason(q('connected','r1_b'),memory([fact('f1','located_in','r1_a')]),{assumptions:[assumption('a1','connected','r1_b')]});
  assert.equal(r.status,'supported');
  assert.equal(r.hypothetical,true);
  assert.deepEqual(r.defeatedAssumptions,[]);
});

test('an explicit contrary fact defeats the assumption and blocks its derivations',()=>{
  const rule={id:'doorRule',if:[atom('door_open',['a','b'])],then:atom('connected',['a','b'])};
  const world={facts:[fact('f1','located_in','r1_a'),fact('f2','door_open',['a','b'],true)],rules:[rule],complete:true};
  const r=reason(q('connected','a','b'),world,{assumptions:[assumption('a1','door_open',['a','b'])]});
  assert.equal(r.status,'unknown');
  assert.equal(r.hypothetical,false);
  assert.deepEqual(r.defeatedAssumptions,['a1']);
});

test('without the contrary fact the same rule derives support hypothetically',()=>{
  const rule={id:'doorRule',if:[atom('door_open',['a','b'])],then:atom('connected',['a','b'])};
  const world={facts:[fact('f1','located_in','r1_a')],rules:[rule],complete:true};
  const r=reason(q('connected','a','b'),world,{assumptions:[assumption('a1','door_open',['a','b'])]});
  assert.equal(r.status,'supported');
  assert.equal(r.hypothetical,true);
});

test('a fact-established atom makes the redundant assumption clean evidence',()=>{
  const r=reason(q('connected','r1_b'),memory([fact('f1','connected','r1_b')]),{assumptions:[assumption('a1','connected','r1_b')]});
  assert.equal(r.status,'supported');
  assert.equal(r.hypothetical,false,'answer proof comes from the admitted fact, not the assumption');
});

test('an assumption never defeats an explicit negative fact',()=>{
  const r=reason(q('connected','r1_b'),memory([fact('f2','connected','r1_b',true)]),{assumptions:[assumption('a1','connected','r1_b')]});
  assert.equal(r.status,'refuted');
  assert.equal(r.hypothetical,false);
});

test('contradicting assumptions keep the conflict visible instead of picking a winner',()=>{
  const r=reason(q('connected','r1_b'),memory([]),{assumptions:[assumption('a1','connected','r1_b'),assumption('a2','connected','r1_b',true)]});
  assert.equal(r.status,'both');
  assert.equal(r.hypothetical,true);
});

test('the prolog adapter applies the same defeat before merging into SWI',{skip:swi},()=>{
  const rule={id:'doorRule',if:[atom('door_open',['a','b'])],then:atom('connected',['a','b'])};
  const assumptions=[assumption('a1','door_open',['a','b'])];
  const defeated=solveHorn(q('connected','a','b'),{facts:[fact('f2','door_open',['a','b'],true)],rules:[rule],complete:true},{backend:'prolog',assumptions});
  assert.equal(defeated.status,'unknown');
  assert.equal(defeated.hypothetical,false);
  const kept=solveHorn(q('connected','a','b'),{facts:[fact('f1','located_in','r1_a')],rules:[rule],complete:true},{backend:'prolog',assumptions});
  assert.equal(kept.status,'supported');
  assert.equal(kept.hypothetical,true);
});
