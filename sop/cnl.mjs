import {emitAtom} from './parser.mjs';
import {emitCondition} from '../lib/conditions.mjs';
import {formatTime} from '../lib/time.mjs';
import {renderAnswer} from './answer-text.mjs';
import {line, variants} from './replies.mjs';
/** The status sentences are `line_status_*` replies of the conversation layer (sop/replies.mjs, DS023 "Conversation layer"). */
const messages={en:new Proxy({},{get:(_,key)=>typeof key==='string'&&variants('line_status_'+key).length?line('status_'+key):undefined})};
/** The English rendering of a result packet. Other answer languages are produced by translating this text at the output edge (lib/translator-service/answer.mjs, DS014 "English-only core"); `language` is accepted and ignored. */
export function cnl(packet,_language,{lexicon=null}={}){
 // A query result is written as a natural answer from the packet (sop/answer-text.mjs); the packet keeps the structured form.
 const natural=renderAnswer(packet,{lexicon});if(natural!==null)return {kind:'cnl',language:'en',text:natural,packet};
 const m=messages.en,lines=[];if(packet.hypothetical)lines.push(m.hypothetical);
 // A solved constraint (a puzzle) first states the values of its asked variables: a value is given only when every solution agrees on it.
 const projected=Object.entries(packet.outputProjection??{});
 if(packet.kind==='constraint'&&projected.length&&['possible','entailed','optimal'].includes(packet.status)){
  const shown=projected.map(([name,item])=>item.status==='bound'&&!Array.isArray(item.value)?name.replace(/^\?/,'')+' = '+item.value:item.status==='ambiguous'?name.replace(/^\?/,'')+' is not decided ('+item.candidates+' possible values)':null).filter(Boolean);
  if(shown.length)lines.push(line('answer_one',{items:shown.join('; ')}));
 }
 lines.push(packet.status==='clarify'?packet.text:(m[packet.status==='approximate'?(packet.patterns?'patterns':packet.mappings?'mappings':'candidates'):packet.status]??packet.status));
 if(packet.status==='budget_exhausted'&&packet.reason)lines.push('REASON '+packet.reason);
 if(packet.kind==='count'&&packet.count!==undefined)lines.push(line('retrieved_count',{count:packet.count}));
 if(packet.at_least!==undefined)lines.push(line('retrieved_at_least',{count:packet.at_least}));
 if(packet.kind==='every'){if(Number.isInteger(packet.members))lines.push(line('members_checked',{count:packet.members}));for(const b of (packet.counterexamples??[]).slice(0,5))lines.push('COUNTEREXAMPLE '+Object.entries(b).map(([k,v])=>k+' = '+JSON.stringify(v)).join('; '));if(packet.undecided?.length)lines.push('UNDECIDED '+packet.undecided.length);}
 if(packet.explanation)lines.push('EXPLANATION '+packet.explanation.kind.toUpperCase());
 for(const row of packet.answers??[]){if(packet.kind==='explain'&&!Object.keys(row.binding).length)continue;lines.push('ANSWER '+Object.entries(row.binding).map(([k,v])=>k+' = '+JSON.stringify(v)).join('; '));if(packet.query?.during&&row.valid)lines.push('VALID ['+formatTime(row.valid.from)+', '+formatTime(row.valid.until)+')');}
 for(const [name,item]of Object.entries(packet.outputProjection??{}))if(item.status==='bound')lines.push('VALUE '+name+' = '+JSON.stringify(item.value));
 for(const p of packet.proof??[])lines.push('EVIDENCE '+p.id+': '+emitAtom(p.atom)+(packet.query?.during&&p.valid?' VALID ['+formatTime(p.valid.from)+', '+formatTime(p.valid.until)+')':'')+(p.kind==='derived'?' VIA '+p.rule+' FROM '+p.from.join(', '):' SOURCE '+p.source));
 if(packet.objective!==undefined)lines.push('OBJECTIVE '+packet.direction+' = '+packet.objective);
 for(const h of (packet.explanations??[]).slice(0,5))lines.push('HYPOTHESIS '+h.hypotheses.join('+')+' COST '+h.cost+': '+h.atoms.join(' AND '));
 if(packet.next_test)lines.push('SUGGESTED_TEST '+packet.next_test.query.where.map(c=>emitCondition(c,emitAtom)).join(' AND ')+'; NOT_EXECUTED');
 for(const p of (packet.patterns??[]).slice(0,5))lines.push('PATTERN '+p.id+': '+p.if.map(emitAtom).join(' AND ')+' -> '+emitAtom(p.then)+'; SUPPORT '+p.training.supportCount+'/'+p.training.opportunities+'; COUNTEREXAMPLES '+p.training.counterexamples+'; UNKNOWN '+p.training.unknown+'; NOT_A_RULE');
 for(const c of (packet.candidates??[]).slice(0,5))lines.push('CANDIDATE '+c.id+' SCORE '+c.score+'; NOT_PROBABILITY');
 for(const a of (packet.mappings??[]).slice(0,5))lines.push('ANALOGY '+JSON.stringify(a.mapping)+' MATCHED '+a.matched+'/'+a.sourceEdges+'; CANDIDATE_TRANSFER');
 if(packet.plan){lines.push('PLAN COST '+packet.plan.cost+'; '+(packet.guarantee==='exact'?'OPTIMAL_WITHIN_MODEL':'OPTIMALITY_NOT_ESTABLISHED'));packet.plan.sequence.forEach((step,i)=>lines.push('STEP '+(i+1)+' '+step.action+' '+JSON.stringify(step.binding)));}
 for(const a of packet.whatif?.intervention??[])lines.push('INTERVENTION '+a+'; NOT_STORED');
 if(packet.route)lines.push('ENGINE '+packet.reasoningStrategy+' / '+packet.route.backend+(packet.route.fallback?' / '+packet.route.fallback:''));
 if(packet.complete===false&&packet.status!=='incomplete')lines.push(m.incomplete);
 return {kind:'cnl',language:'en',text:lines.filter(Boolean).join('\n'),packet};
}
