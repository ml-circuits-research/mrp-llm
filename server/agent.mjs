import {assert, digest} from '../lib/util.mjs';
import {admitCircuits} from '../lib/query-author/session.mjs';
import {AuthorRuntime, memoryCircuits} from '../lib/query-author/runtime.mjs';
import {authorExecution} from '../lib/query-author/execution-context.mjs';
import {Sessions} from '../lib/chat-data/sessions.mjs';
import {composeReply, answered, layerInfo} from '../lib/conversation/index.mjs';
import {behaviourOf, applyInstructions, overlayOf, timeFacts, recordReactions, personalFacts} from '../lib/conversation/behaviour.mjs';
import {entityRelations} from '../lib/near-miss.mjs';
import {factSentence} from '../sop/answer-text.mjs';
import {nearMiss} from '../lib/near-miss.mjs';
import {topicsOf} from '../lib/assistant/statistics.mjs';
import path from 'node:path';
import fs from 'node:fs';
/**
 * One chat turn of a conversation (DS009, DS014). The circuit author (the coding agent through server/query-parser.mjs, or a test stub) is
 * the only component that reads the user's words: it gets the message and the vocabulary of the memory and writes circuits. The runtime
 * admits them, the KnowledgeLinker binds their strings to the memory, the StrategyRouter and the oracle compute the answer and the
 * answer is rendered in English from the result packet (sop/answer-text.mjs). Courtesy and emotion are part of the same understanding
 * step: the formalizer writes them as `pragmatic` wires next to the query (or alone, for a message without a request), and the reply
 * and the tone of the answer are rendered from those wires (sop/pragmatic-text.mjs, DS023).
 */
export class Agent{
 constructor({repo,session,lexicon,config,circuitRules=null}){Object.assign(this,{repo,session,lexicon,config,circuitRules});this.recent=[];this.last=null;
  // Caller-owned conversation context: carried statements, the last query (for follow-ups) and, when the runtime
  // configures it, the caller's own entity for "the user" (DS014).
  this.context={statements:[],...(config?.user?{user:config.user}:{})};}
 /**
  * `formalizer` is required: `{id, formalize: async text => sop}`; the server builds it per turn from the request parser, and tests inject
  * their own. The answer is English. The formalizer reads the whole message once: the request (query, statements) and what the message does
  * besides (greeting, thanks, apology, closing, an emotion) as `pragmatic` wires. A message with pragmatic wires only gets the courtesy
  * reply rendered from them, with no computation; otherwise the answer gets the courtesy phrase and tone they ask for.
  */
 async turn(text,{now=Date.now(),formalizer}={}){
  assert(typeof formalizer?.formalize==='function','A turn needs a circuit author: {id, formalize}');
  const started=performance.now();
  const circuits=memoryCircuits(this);
  let preview=null;
  const execute=async source=>{
   const program=admitCircuits(source,text,this.lexicon,{circuits,policy:this.config?.policy});
   const context=structuredClone(this.context);
   const result=await new AuthorRuntime({repo:this.repo,session:this.session,lexicon:program.lexicon,schema:program.lexicon?.predicates,now,policy:this.config?.policy,circuits,definitions:[program.definitionSop,program.hypotheticalSop].filter(Boolean).join('\n')}).run(program.modelSop,{origin:'model',inputText:text,language:'en',languageSource:'default',context});
   preview={sop:source,result,context,program};
   return result.result?.packet??result.result;
  };
  // The repository and session reach the formalization strategy (the step-by-step protocols read observed role fits from them).
  // The addressee of the message: the assistant's own entity in the self layer (config `assistant`), when this memory has it.
  const addressee=this.config?.assistant&&this.lexicon?.entities?.[this.config.assistant]?this.config.assistant:null;
  const sop=await authorExecution.run({execute,circuits,addressee,repo:this.repo,session:this.session,key:digest([circuits.map(c=>c.text),this.context.statements,this.context.user]),contextKey:digest(this.context.lastQuery??''),selfCheck:this.config?.queryParser?.selfCheck!==false},()=>formalizer.formalize(text));
  const formalization={model:formalizer.id??null,ms:Math.round(performance.now()-started)};
  let result,turnOnly=new Set();
  try{
   if(preview?.sop!==sop)await execute(sop);
   result=preview.result;
   this.context=preview.context;
   if(preview.program.definitionSop){
    const folder=this.repo?.root?path.dirname(this.repo.root):null;
    // A definition the coding agent wrote joins the session layer once it validates (no manual acceptance, owner 2026-10-02).
    let added=null,problems=null;
    // A problem's own vocabulary (session predicates its asserted statements use: DS014 "Problems that state their own data") is
    // turn-scoped: it would collide with the next problem's vocabulary in the session layer.
    const declared=new Set([...preview.program.definitionSop.matchAll(/^@([A-Za-z][A-Za-z0-9_]*)\s+predicate\s*$/gm)].map(m=>m[1]));
    const problem=(preview.program.wires??[]).some(w=>w?.type==='stated'&&declared.has(String(w.fields?.relation?.[0]??'').replace(/^"|"$/g,'')));
    if(problem)turnOnly=declared;
    if(!problem&&folder&&fs.existsSync(path.join(folder,'session.json'))){try{added=new Sessions({chatData:{sessionsDir:path.dirname(folder)}}).addCircuit(path.basename(folder),{name:'coding-agent-definition',text:preview.program.definitionSop,model:formalizer.id,origin:'coding_agent'});}catch(error){problems=(error.problems??[{code:error.code,message:error.message}]).slice(0,10);}}
    if(result.result?.packet)result.result.packet.session_circuits={origin:'coding_agent',scope:added?'session':'turn',status:added?'added':problems?'not_added':'turn_only',...(problem?{reason:'problem_vocabulary'}:{}),text:preview.program.definitionSop,...(added?{file:added.file}:{}),...(problems?{problems}:{})};
   }
  }catch(error){throw Object.assign(error,{modelSop:sop,formalization});}
  let output=result.result;
  if(output?.status==='clarify')output={kind:'cnl',text:output.text,language:'en',packet:output};
  assert(output?.kind==='cnl','The runtime must produce a conversational result');
  // The reply is chosen by the JS oracle over the conversation layer (DS023 "Conversation layer"): the packet becomes facts (status,
  // unclear kind, pragmatic signals, answered or not, the near-miss candidate, the memory's topics), the layer's rules derive the
  // applicable replies, and the opening, body and closing of the highest priority are filled from the packet. No phrasing in code.
  const signals=(output.packet?.pragmatic??[]).filter(s=>s.score>=0.5);
  output=this.reply(output,{text,now});
  // A statement over a problem's turn-scoped vocabulary expires with the turn: carried on, it would name a predicate the next turn's
  // schema does not have ("Unknown predicate distance_km", live check 2026-10-02).
  this.context={...this.context,statements:(result.contextStatements??this.context.statements).filter(s=>!turnOnly.has(s.atom?.p))};
  this.last=output;this.recent.push({user:text.slice(0,400),response:output.text.slice(0,500)});this.recent=this.recent.slice(-3);
  const packet=output.packet??{};
  const branches=(result.problemResults??[]).flatMap(p=>p.branch?[p.branch]:[]);
  const conflicts=branches.flatMap(p=>p.session_conflicts??[]);
  if(conflicts.length)packet.session_conflicts=[...(packet.session_conflicts??[]),...conflicts];
  if(this.config?.policy?.reinforce!==false&&this.repo&&this.session&&!packet.hypothetical&&packet.proof?.length){
   const used=packet.proof.filter(f=>f.kind==='observed'&&f.source!=='assumption'&&f.evidence?.metadataVerified&&!f.evidence?.local);
   if(used.length){const promoted=this.repo.reinforce(this.session,used,{usedAt:now});if(promoted.some(x=>x.reinforced))packet.reinforcement={facts:promoted.filter(x=>x.reinforced).length,strength:this.session.live.retention().useStrength};}
  }
  return {sop,executionSop:[result.executionSop,result.pragmaticSop].filter(Boolean).join('\n\n'),cnl:output.text,text:output.text,englishText:output.text,packet:output.packet,trace:result.trace,outputs:result.outputs,blocked:result.blocked,generated:result.generated,
   userStatements:packet.user_statements??[],carriedStatements:packet.carried_statements??[],modelAssumptions:packet.model_assumptions??[],assumptionPolicy:packet.assumption_policy??null,assumptionBranch:packet.assumption_branch??null,
   unclear:packet.status==='unclear'?packet.unclear_kind:null,answerLanguage:'en',formalization,...(signals.length?{pragmatic:{signals,sop:result.pragmaticSop??'',standalone:packet.status==='courtesy'}}:{})};
 }
 /**
  * The reply of a turn from its result packet: the rendered answer of a computed turn is the body's `answer` slot; a turn without an
  * answer (an open answer, an unknown name, a relation the memory lacks, no request) gets the near-miss candidates of its names
  * (lib/near-miss.mjs: fuzzy names of the memory and the relations around them) and the memory's topics as slots.
  */
 reply(output,{text='',now=Date.now(),facts=[],slots={}}={}){
  // `facts`/`slots`: further turn facts and slots of the caller (ChatSOPAdapter's verification status, lib/adapter/reply.mjs).
  const packet=output.packet??{};
  const computed=!['unclear','courtesy','instruction'].includes(packet.status);
  const answerText=computed?output.text:null;
  // A clarification about a name the memory does not know (not an ambiguous one) is a turn without an answer too.
  const unknownNames=(packet.required??[]).filter(i=>i&&(i.kind===undefined||i.kind==='entity')&&i.status!=='ambiguous').map(i=>i.text??i.surface).filter(s=>typeof s==='string'&&s.trim());
  const open=!['courtesy','instruction'].includes(packet.status)&&(packet.status!=='clarify'||unknownNames.length>0)&&!(computed&&answered(packet));
  const started=performance.now();
  let near=null;
  if(open&&this.lexicon){
   const mentions=unknownNames;
   try{near=nearMiss({text,mentions,lexicon:this.lexicon,repo:this.repo,session:this.session,max:3});}catch(error){near={candidates:[],error:error.message};}
   if(near)near.ms=Math.round(performance.now()-started);
  }
  // The behaviour of the conversation (DS023 "Behaviour layer"): this turn's instructions, the turn number and the time since each
  // reaction become facts; the active instructions join the layer as data (reply wires and rules, origin user).
  const state=behaviourOf(this.context),clock={turn:++state.turn,at:now},info=layerInfo();
  // The runtime already applied this message's instructions to the conversation context (sop/declarative.mjs); otherwise only the active ones count.
  const instructed=packet.instruction_outcome??applyInstructions(state,[],clock);
  delete packet.instruction_outcome;
  const aside=computed&&answered(packet)?this.asideFact(packet,now):null;
  // The user's name (kept from an act that sets a slot) and the time of day: facts and slots when known, nothing otherwise (P-2.3).
  const personal=personalFacts(state,packet.pragmatic??[],info,clock);
  const composed=composeReply({packet,answerText,near,topics:topicsOf(this.lexicon),aside,seed:now,facts:[...instructed.facts,...timeFacts(state,info,clock),...personal.facts,...facts],slots:{...instructed.slots,...personal.slots,...slots},overlay:overlayOf(state)});
  recordReactions(state,composed.reply,info,clock);
  packet.reply=composed.reply;
  packet.behaviour={turn:clock.turn,instructions:state.instructions.map(i=>({id:i.id,kind:i.kind,text:i.text??null,since_turn:i.set.turn})),...(instructed.changes.length?{changes:instructed.changes}:{})};
  if(near?.candidates?.length)packet.near_miss={candidates:near.candidates.slice(0,3).map(c=>({id:c.id,label:c.label,description:c.description??null,distance:c.distance,mention:c.mention,relations:(c.relations??[]).slice(0,6).map(r=>({predicate:r.predicate,facts:r.facts}))})),ms:near.ms};
  return {...output,text:composed.text,packet};
 }
 /**
  * Another fact the memory holds about something in the answer (the aside of the drive `aside_fact`): the first answer value that is an
  * entity of the memory, one of its relations other than the ones asked, one stored example, as a sentence. Null when there is none.
  */
 asideFact(packet,now){
  try{
   const asked=new Set((packet.query?.where??[]).map(a=>a?.p).filter(Boolean));
   const values=[...(packet.rows??[]).flatMap(r=>Object.values(r??{})),...(packet.answers??[]).flatMap(a=>Object.values(a?.binding??{}))];
   const id=values.find(v=>typeof v==='string'&&this.lexicon?.entities?.[v]&&!this.lexicon.isClass?.(v));
   if(!id)return null;
   const relations=entityRelations(id,{lexicon:this.lexicon,repo:this.repo,session:this.session,maxRelations:12,examples:2}).relations.filter(r=>!asked.has(r.predicate)&&r.examples?.length&&!(this.lexicon.predicates[r.predicate]?.readings??[]).includes('class'));
   if(!relations.length)return null;
   const r=relations[Math.abs(Math.floor(now/1000))%relations.length];
   return factSentence({p:r.predicate,a:r.examples[0],neg:false},{lexicon:this.lexicon});
  }catch{return null;}
 }
 /**
  * Admission of proposition circuits and turn-local session definitions against
  * accepted memory. Links and value references name wires of this output.
  * Stated values are anchored to the message; unparsed spans are verbatim.
  * Proposed definitions do not modify the accepted theory or base memory.
  */
 validateVocabulary(sop,text=''){
  return admitCircuits(sop,text,this.lexicon,{circuits:this.repo?memoryCircuits(this):undefined,policy:this.config?.policy});
 }
}
