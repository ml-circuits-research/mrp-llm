import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../../sop/runtime.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {parse} from '../../sop/parser.mjs';
import {context as repositoryContext} from '../helpers.mjs';

// A host lexicon: the context-free model writes strings, the host links them (DS014).
const lexicon=new Lexicon('@temperature predicate\n  role subject entity\n  role object integer\n  label en "temperature of"\n@room_a entity\n  kind entity\n  label en "room A"');
const schema=lexicon.predicates;
const question='@q query\n  where match\n    relation "temperature of"\n    role subject "room A"\n    role object ?degrees\n    polarity affirmed\n  end\n  select ?degrees';
const runtime=()=>new Runtime({schema,lexicon});
const temperature=(id,value,{type='stated',certainty='asserted',extra=''}={})=>`@${id} ${type}\n  relation "temperature of"\n  role subject "room A"\n  role object "${value}"\n  polarity affirmed\n`+(type==='stated'?`  certainty ${certainty}\n`:'')+extra;

test('an asserted user statement is turn evidence, is carried in caller context and is never stored',async()=>{
 const c=repositoryContext({bootstrap:false}),context={};
 try{
  const engine=new Runtime({repo:c.repo,session:c.session,schema,lexicon});
  const before=Object.keys(c.session.live.claims).length;
  const first=await engine.run(temperature('s',21),{origin:'model',inputText:'The room is 21 degrees.',context});
  assert.equal(first.result.packet.status,'context_updated');
  assert.deepEqual(context.statements.map(s=>[s.origin,s.text]),[['user-statement','The room is 21 degrees.']]);
  assert.equal(first.result.packet.user_statements[0].treatment,'evidence');
  const answer=await engine.run(question,{origin:'model',context});
  assert.equal(answer.result.packet.status,'supported');
  assert.equal(answer.result.packet.hypothetical,false,'what the user asserted is not a hypothesis');
  assert.deepEqual(answer.result.packet.answers.map(a=>a.binding),[{'?degrees':21}]);
  assert.equal(answer.result.packet.carried_statements.length,1);
  assert.equal(Object.keys(c.session.live.claims).length,before);
  const other=await engine.run(question,{origin:'model',context:{}});
  assert.equal(other.result.packet.status,'unknown');
 }finally{c.dispose();}
});

test('conditional query scalars feed numeric problems without model-authored operations',async()=>{
 const source=`${temperature('p',21,{certainty:'supposed'})}${question}
@limit constraint
  var ?next int 0 100
  require ?next equal $degrees plus 1
  claim ?next at_most 25
  select ?next
  task possible`;
 const out=await runtime().run(source,{origin:'model'});
 assert.equal(out.values.degrees,21);
 assert.equal(out.values.next,22);
 assert.equal(out.result.packet.status,'possible');
 assert.equal(out.result.packet.hypothetical,true);
 assert.equal(out.outputs.next.hypothetical,true);
 assert.deepEqual(out.problemResults.map(p=>p.id),['q','limit']);
});

test('multiple conditional scalar matches stop dependent calculation and request clarification',async()=>{
 const source=`${temperature('p',21,{certainty:'supposed'})}${temperature('other',22,{certainty:'supposed'})}${question}
@limit constraint
  var ?next int 0 100
  require ?next equal $degrees plus 1
  claim ?next at_most 25
  task possible`;
 const out=await runtime().run(source,{origin:'model'});
 assert.equal(out.outputs.degrees.status,'ambiguous');
 assert.equal(Object.hasOwn(out.values,'limit'),false);
 assert.equal(out.result.packet.status,'clarify');
 assert.equal(out.result.packet.next,'answer_clarification');
 assert.equal(out.result.packet.required.find(p=>p.name==='degrees').status,'ambiguous');
 assert.equal(parse(out.result.packet.pendingSop).wires.at(-1).type,'constraint');
 assert.equal(parse(out.executionSop).wires.at(-1).type,'clarify');
});

const ontology=`@maria_one entity
  kind person
  label en "Maria One"
  alias en "Maria"
@maria_two entity
  kind person
  label en "Maria Two"
  alias en "Maria"
@acme entity
  kind organization
  label en "Acme"
  alias ro "Laboratorul Alfa"
@works_at predicate
  role subject person
  role object organization
  label en "works at"`;
const worksAt=(subject,object)=>`@q query\n  where match\n    relation "works at"\n    role subject "${subject}"\n    role object "${object}"\n    polarity affirmed\n  end`;

test('host identity lookup asks about homonyms but missing evidence remains unknown',async()=>{
 const lexicon=new Lexicon(ontology),engine=new Runtime({lexicon,schema:lexicon.predicates});
 const ambiguous=await engine.run(worksAt('Maria','Acme'),{origin:'model',inputText:'Does Maria work at Acme?'});
 assert.equal(ambiguous.result.packet.status,'clarify');
 assert.deepEqual(ambiguous.result.packet.required[0].candidates.map(c=>c.id),['maria_one','maria_two']);
 const known=await engine.run(worksAt('Maria One','Acme'),{origin:'model'});
 assert.equal(known.result.packet.status,'unknown');
 const alias=await engine.run(worksAt('Maria One','Laboratorul Alfa'),{origin:'model',language:'en'});
 assert.equal(alias.result.packet.status,'unknown');
 assert.equal(alias.result.packet.query.where[0].a[1],'acme');
});
test('a closed match absence is decided by exact runtime evidence, not by explicit negation', async () => {
 const closed = new Lexicon('@cleared predicate\n  args subject:entity\n  label en "cleared"\n  closed true\n@dana entity\n  kind entity\n  label en "Dana"');
 const query = '@q query\n  where match\n    relation "cleared"\n    role subject "Dana"\n    polarity absent\n  end';
 const engine = new Runtime({lexicon: closed, schema: closed.predicates});
 assert.equal((await engine.run(query, {origin: 'model'})).result.packet.status, 'supported');
 const asserted = '@s stated\n  relation "cleared"\n  role subject "Dana"\n  polarity affirmed\n  certainty asserted\n';
 assert.equal((await engine.run(asserted + query, {origin: 'model'})).result.packet.status, 'refuted');
 const open = new Lexicon('@cleared predicate\n  args subject:entity\n  label en "cleared"\n@dana entity\n  kind entity\n  label en "Dana"');
 await assert.rejects(() => new Runtime({lexicon: open, schema: open.predicates}).run(query, {origin: 'model'}), /absent_needs_closed/);
});

test('model origin rejects operation, sourced fact and clarification authoring',async()=>{
 const sources=[
  ['clarify','@x clarify\n  text "Which one?"'],
  ['fact','@x fact\n  holds temperature room_a 21\n  valid timeless'],
  ['remember',temperature('p',21)+'@x remember\n  input $p'],
  ['solve',question+'\n@x solve\n  query $q'],
  ['jsEval','@x jsEval\n  expr 1 + 2'],
  ['value','@x value\n  data 1 + 2']
 ];
 for(const [type,source] of sources){
  await assert.rejects(runtime().run(source,{origin:'model'}),new RegExp(`Model authors stated, assumed, unclear, query, constraint, unparsed, pragmatic or instruction; ${type} belongs to symbolic execution`),type);
 }
});

test('trusted remember cannot promote an assumption into sourced knowledge',async()=>{
 const c=repositoryContext({bootstrap:false});
 try{
  const engine=new Runtime({repo:c.repo,session:c.session,schema});
  const before=Object.keys(c.session.live.claims).length;
  await assert.rejects(engine.run('@p fact\n  holds temperature room_a 21\n  valid timeless\n  source assumption\n@s remember\n  input $p'),/assumption_fact_unconsumed/);
  assert.equal(Object.keys(c.session.live.claims).length,before);
 }finally{c.dispose();}
});

test('host-generated operations cannot collide with authored expansion-shaped names',async()=>{
 const out=await runtime().run(temperature('host0__link',21)+question,{origin:'model'});
 assert.deepEqual(out.result.packet.answers.map(a=>a.binding),[{'?degrees':21}]);
 assert.equal(out.values.host0__link.kind,'fact');
 assert.equal(out.values.host0__link.source,'user');
});

test('requested scalar ambiguity requires clarification even when the claim is entailed',async()=>{
 const source='@problem constraint\n  var ?x int 1 2\n  claim ?x at_least 1\n  select ?x\n  task prove';
 const out=await runtime().run(source,{origin:'model'});
 assert.equal(out.problemResults[0].result.status,'entailed');
 assert.equal(out.result.packet.status,'clarify');
 assert.equal(out.result.packet.next,'answer_clarification');
 assert.deepEqual(out.result.packet.required,[{name:'x',status:'ambiguous',candidates:2}]);
 assert.equal(out.outputs.x.status,'ambiguous');
 assert.equal(Object.hasOwn(out.values,'x'),false);
});
