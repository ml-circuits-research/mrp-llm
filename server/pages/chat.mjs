/** Browser chat on top of `POST /v1/chat/completions` (DS009 "The chat page", DS022).
 *
 * Layout: a left sidebar with three vertical tabs (an icon rail or top bar below 760 px), each a `tabpanel` with arrow-key navigation:
 * *Chat* (session header with the base memory and "New session", the message list that keeps the newest message in view and shows a
 * "new messages" pill when the user has scrolled up, the attach button and a composer that grows to five lines, Enter sends, Shift+Enter
 * adds a line), *Settings* (cards: Formalization, with the strategy selector and the first tier of the ladder; Server status) and *Base Memory* (table of base memories with View, Fork, Add knowledge and Start
 * session). Markup is built here, the CSS is `chat/style.mjs`, the product layer (sessions, base memories, knowledge authoring) is
 * `chat-product.mjs`.
 *
 * The message goes to the server as typed, in any language: the request parser (the session's formalization strategy, step by step by
 * default) assembles the circuit, the runtime validates, links, retrieves, routes, verifies and renders it, and the answer comes back in
 * English with its trace. The trace panel follows the pipeline: formalization (strategy, tiers, questions), vocabulary (schema
 * neighbourhood, vocabulary dialog), session definitions and assumptions (labelled with their origin), linking, retrieval
 * (complete or not, bounds), route and verification, latency, then the circuits. Linked entities and relations open their cards in the
 * knowledge browser (`/review?session=…&entity=…`, server/pages/review.mjs). `parse_unavailable` (503) and `parse_failed` (422)
 * are explained in plain words. The page uses the HttpOnly session cookie through same-origin
 * fetch; it never sees a credential. The server owns conversation context per `conversation_id`; the page keeps a local transcript copy
 * for display. SOP in the trace is rendered by server/pages/sop-code.mjs. All dynamic text is inserted with textContent. */
import {escapeHtml, layout} from './layout.mjs';
import {SOP_CODE_STYLE, sopCodeScript} from './sop-code.mjs';
import {CHAT_STYLE} from './chat/style.mjs';
import {symbolicTabHtml, symbolicScript, SYMBOLIC_ICON, SYMBOLIC_STYLE} from './chat-symbolic.mjs';
import {settingsModelHtml, settingsFormalizerModelHtml, memoryTabHtml, sessionHeadHtml, productDialogsHtml, attachHtml, chipsHtml, productScript} from './chat-product.mjs';

const ICONS = {
  symbolic: SYMBOLIC_ICON,
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  memory: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
};
const SEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const script = `
const $=id=>document.getElementById(id);
const MODEL=document.body.dataset.model;
const EXAMPLE='Ask something, in any language. The model and the answer language are chosen under Settings.';
const store={get(key,fallback){try{const v=localStorage.getItem(key);return v?JSON.parse(v):fallback}catch{return fallback}},set(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}};
let conversations=store.get('chatsop.conversations',['default']);
let current=store.get('chatsop.current','default');
if(!conversations.includes(current))conversations.unshift(current);
let sending=false;
// While a message is processed (the formalizer writes the circuit, the runtime answers) the composer is blocked and says what is running.
function setBusy(on,stage){
 sending=on;for(const id of ['input','send','attach']){const e=$(id);if(e)e.disabled=on;}
 $('busy').hidden=!on;if(on)$('busy-text').textContent=stage||'Working\u2026';
 $('composer').classList.toggle('busy',on);
 if(!on)$('input').focus({preventScroll:true});
}
const stage=text=>{if(sending)$('busy-text').textContent=text;};
const TABS=['chat','settings','memory','symbolic'];
function switchTab(name,focus){
 if(!TABS.includes(name))name='chat';
 for(const t of TABS){const on=t===name;$('tab-'+t).setAttribute('aria-selected',String(on));$('tab-'+t).tabIndex=on?0:-1;$('panel-'+t).hidden=!on;}
 store.set('chatsop.activeTab',name);if(focus)$('tab-'+name).focus();
 if(name==='memory'&&typeof renderMemories==='function')renderMemories();
 if(name==='symbolic'&&typeof loadSymbolic==='function')loadSymbolic();
 if(name==='chat'){scrollBottom();$('input').focus({preventScroll:true});}
}
function initTabs(){
 for(const t of TABS)$('tab-'+t).onclick=()=>switchTab(t);
 $('tab-chat').parentNode.addEventListener('keydown',e=>{
  const at=TABS.findIndex(t=>$('tab-'+t)===document.activeElement);if(at<0)return;
  const to={ArrowDown:at+1,ArrowRight:at+1,ArrowUp:at-1,ArrowLeft:at-1,Home:0,End:TABS.length-1}[e.key];
  if(to===undefined)return;e.preventDefault();switchTab(TABS[(to+TABS.length)%TABS.length],true);
 });
 switchTab(store.get('chatsop.activeTab','chat'));
}
const transcript=id=>store.get('chatsop.transcript.'+id,[]);
const saveTranscript=(id,items)=>store.set('chatsop.transcript.'+id,items.slice(-100));
function renderSelect(){const select=$('conversation');select.textContent='';for(const id of conversations){const option=document.createElement('option');option.value=id;option.textContent=id;option.selected=id===current;select.append(option);}}
function field(list,label,value){if(value===undefined||value===null||value==='')return;const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=typeof value==='string'?value:JSON.stringify(value);list.append(dt,dd);}
function block(parent,label,text){if(!text)return;const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=label;const pre=document.createElement('pre');pre.textContent=typeof text==='string'?text:JSON.stringify(text,null,2);details.append(summary,pre);parent.append(details);}
function sopBlock(parent,label,text){if(!text)return;const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=label;const pre=document.createElement('pre');const code=document.createElement('code');if(typeof text==='string'&&window.ChatSopCode)code.innerHTML=window.ChatSopCode.render(text);else code.textContent=typeof text==='string'?text:JSON.stringify(text,null,2);pre.append(code);details.append(summary,pre);parent.append(details);}
/** One line of the linking report of the packet: the surface, the symbol it was bound to, what matched and the alternatives not taken. */
function linkingLine(e){
 let how;
 if(e.via==='copula_reading')how='copula reading '+(e.reading||'');
 else if(e.via==='lexicon')how=e.form?e.form.kind+' \u201c'+e.form.text+'\u201d'+(e.form.language?' ('+e.form.language+')':''):'memory vocabulary';
 else how=e.via+(e.form?' \u201c'+(e.form.text||e.form)+'\u201d':'');
 return '\u201c'+e.surface+'\u201d \u2192 '+e.symbol+' ('+e.kind+(e.class?' of '+e.class:'')+'; '+how+(e.match&&e.match!=='exact'?'; '+e.match:'')+')'+(e.score!=null?'; score '+e.score+(e.decided_by?' by '+e.decided_by:''):'')+((e.scored_alternatives||[]).length?'; alternatives: '+e.scored_alternatives.map(a=>a.id+' ('+a.score+')').join(', '):(e.alternatives||[]).length?'; alternatives: '+e.alternatives.join(', '):'');
}

// The trace of one answer, in the order of the pipeline: formalization, vocabulary, session definitions and assumptions, linking,
// retrieval, route and verification, latency, then the circuits and the raw provenance.
const secs=ms=>typeof ms==='number'?(ms/1000).toFixed(2)+' s':null;
function section(parent,title,open){const d=document.createElement('details');d.className='tsec';if(open)d.open=true;const s=document.createElement('summary');s.textContent=title;const dl=document.createElement('dl');d.append(s,dl);parent.append(d);return {box:d,list:dl};}
function listField(list,label,items){if(!items||!items.length)return;const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');const ul=document.createElement('ul');for(const t of items){const li=document.createElement('li');li.textContent=t;ul.append(li);}dd.append(ul);list.append(dt,dd);}
const yes=v=>v===true?'yes':v===false?'no':v;
// Names in the trace open their cards in the knowledge browser (/review, server/pages/review.mjs) over this chat's session or base memory.
function browseHref(c,kind,id){const t=c.session?.id?'session='+encodeURIComponent(c.session.id):'memory='+encodeURIComponent(c.session?.base||'world-v1');return '/review?'+t+'&'+kind+'='+encodeURIComponent(id);}
function browseLink(c,kind,id,text){const a=document.createElement('a');a.href=browseHref(c,kind,id);a.target='_blank';a.rel='noopener';a.textContent=text||id;a.title='open the '+kind+' card in the knowledge browser';return a;}
function browseField(list,label,c,refs){refs=(refs||[]).filter(r=>r&&r.id);if(!refs.length)return;const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');refs.forEach((r,i)=>{if(i)dd.append(', ');dd.append(browseLink(c,r.kind,r.id));});list.append(dt,dd);}
// The MRP slots around the symbolic core (lib/mrp/pipeline.mjs): the model, the English the core read, each slot's strategy and result.
function mrpSection(details,m){
 const g=section(details,'0. MRP-LLM pipeline (model '+m.model+')',true).list;
 field(g,'model',m.model);
 if(m.english&&m.english!==m.original)field(g,'English read by the system',m.english);
 field(g,'message language \u2192 answer language',(m.language||'?')+' \u2192 '+(m.output||'?'));
 for(const t of m.trace||[]){
  const bits=[t.strategy];
  if(t.slot==='normalize')bits.push(t.changed?'rewritten':'unchanged');
  if(t.slot==='reflex'){bits.push(t.fired?'answered from the FAQ':'no reflex');if(t.best)bits.push('best '+t.best.id+' '+t.best.score+(t.threshold!=null?' / boundary '+t.threshold:''));if(t.margin!=null)bits.push('margin '+t.margin);if(t.judge)bits.push('judge '+JSON.stringify(t.judge));if(t.note)bits.push(t.note);}
  if(t.slot==='affect'&&t.label)bits.push(t.label+' '+t.intensity);
  if(t.slot==='roundtrip'){if(t.ran)bits.push('restated: \u201c'+t.restated+'\u201d, agreement '+t.score+(t.agree===false?' (MISMATCH)':t.agree?' (agrees)':''));else bits.push(t.note||'not run');}
  if(t.slot==='voice')bits.push(t.applied?'phrased in '+t.output:'English answer kept'+(t.note?' ('+t.note+')':''));
  if(t.degraded)bits.push('degraded: '+t.degraded);
  if(t.served)bits.push('by '+t.served);
  if(t.ms!=null)bits.push(secs(t.ms));
  field(g,t.slot,bits.filter(Boolean).join(' \u00b7 '));
 }
 if(m.commit)field(g,'commit',m.commit.policy+': '+(m.commit.queued!=null?m.commit.queued+' queued for review':m.commit.written!=null?m.commit.written+' written to the memory':m.commit.error||''));
 if((m.overridden||[]).length)field(g,'overrides',m.overridden.join(', '));
 if(m.slots)field(g,'strategies',Object.entries(m.slots).map(([k,v])=>k+'='+v.strategy).join(', '));
}
function traceView(c){
 const p=c.parse||{};const details=document.createElement('details');details.className='trace';const summary=document.createElement('summary');
 const total=c.turn_ms??c.client_ms??c.formalization_ms;
 summary.textContent='how this answer was made · '+(c.strategy||p.strategy||'formalizer')+(p.model?' ('+p.model+')':'')+' · '+(c.status??'no status')+(typeof total==='number'?' · '+secs(total):'');
 details.append(summary);
 // 1. Formalization: the strategy, the tiers that answered its questions, escalations and the guards that sent it back.
 if(c.mrp)mrpSection(details,c.mrp);
 const f=section(details,'1. Formalization (request parser)',true).list;
 field(f,'strategy',c.strategy||p.strategy);field(f,'model',p.model);
 if(p.tried&&p.tried.length)field(f,'models tried before',p.tried.map(t=>typeof t==='string'?t:t.model+': '+t.reason).join('; '));
 if(p.strategy_note)field(f,'note',p.strategy_note);
 if(p.ladder&&p.ladder.length)field(f,'tier ladder',p.ladder.join(' \u2192 '));
 if(p.steps!=null)field(f,'questions',String(p.steps));
 if(p.tiers&&p.tiers.escalated&&p.tiers.escalated.length)field(f,'escalated questions',p.tiers.escalated.map(e=>e.question+' ('+e.tier+')').join(', '));
 listField(f,'repair rounds',(p.repairs||[]).map(r=>'round '+r.round+': '+r.problems.join(', ')));
 field(f,'cache',p.cache);if(p.cost_usd)field(f,'cost',' $'+Number(p.cost_usd).toFixed(4)+' (nominal for subscriptions)');
 field(f,'time',secs(p.ms??c.formalization_ms));
 if(p.failed)field(f,'failed',p.failed);if(c.rejection)field(f,'rejected because',c.rejection);
 field(f,'unclear',c.unclear||p.unclear);field(f,'understood as',c.understood_as);
 if(p.closest&&p.closest.length)field(f,'closest relations',p.closest.map(x=>x.id).join(', '));
 // 2. Vocabulary: the schema neighbourhood offered to the author and the bounded vocabulary dialog.
 if(p.retrieval||p.vocabulary_dialog){const v=section(details,'2. Vocabulary (schema neighbourhood and dialog)').list;const r=p.retrieval||{};
  field(v,'relations offered',r.predicates!=null?String(r.predicates):null);field(v,'entity mentions found',r.entity_mentions!=null?String(r.entity_mentions):null);
  if(r.neighbourhood&&r.neighbourhood.predicates)field(v,'schema neighbourhood',r.neighbourhood.predicates.length+' relation(s): '+r.neighbourhood.predicates.slice(0,12).map(x=>x.id).join(', ')+(r.neighbourhood.predicates.length>12?', …':''));
  if(r.neighbourhood&&r.neighbourhood.predicates)browseField(v,'browse relations',c,r.neighbourhood.predicates.slice(0,12).map(x=>({kind:'predicate',id:x.id})));
  if(r.byte_budget)field(v,'vocabulary size',r.bytes+' of '+r.byte_budget+' bytes'+(r.truncated?' (truncated)':''));
  const d=p.vocabulary_dialog;if(d)field(v,'vocabulary dialog',d.rounds?d.rounds+' expansion(s) of at most '+d.max_rounds+': '+d.expansions.map(e=>e.trigger).join(', '):'not needed');}
 // 2b. Pragmatic wires the formalizer wrote (DS023): courtesy and emotion, advisory, never facts.
 if((c.pragmatic||[]).length){const g=section(details,'2b. Courtesy and emotion (pragmatic wires of the formalizer)',true).list;
  listField(g,'signals',c.pragmatic.map(x=>x.kind+(x.span?' · "'+x.span+'"':'')+' · '+(x.source?x.source+'/':'')+x.basis));}
 // 2c. The reply chosen by the JS oracle over the conversation layer (DS023 "Conversation layer"): why this reply, what it outranked.
 if(c.reply){const g=section(details,'2c. Reply (chosen by reasoning over the conversation layer)',true).list;const r=c.reply;
  for(const part of ['prefix','opening','body','aside','follow_up','closing','suffix'])if(r[part])listField(g,part+': '+r[part].situation+' (priority '+r[part].priority+', '+r[part].variants+' variant'+(r[part].variants===1?'':'s')+(r[part].outranked&&r[part].outranked.length?'; outranked '+r[part].outranked.join(', '):'')+')',r[part].why||[]);
  if(r.style)field(g,'style',r.style);listField(g,'turn facts',r.facts||[]);field(g,'time',(r.ms??0)+' ms · '+(r.layer||''));
  if(c.behaviour&&(c.behaviour.instructions||[]).length)listField(g,'your instructions',c.behaviour.instructions.map(i=>i.kind+(i.text?' "'+i.text+'"':'')+' (since turn '+i.since_turn+')'));
  if(c.near_miss&&c.near_miss.candidates)listField(g,'near names',c.near_miss.candidates.map(x=>x.label+(x.description?' ('+x.description+')':'')+' · distance '+x.distance+' · for "'+x.mention+'"'));}
 // 3. Session definitions and assumptions: labelled with their origin (no manual acceptance).
 const sc=c.session_circuits;
 if(sc||(c.model_assumptions||[]).length||(c.user_statements||[]).length||(c.carried_statements||[]).length){const s=section(details,'3. Session definitions and assumptions',Boolean(sc));
  if(sc){field(s.list,'definition','defined by the '+(sc.origin==='coding_agent'?'formalizer':sc.origin)+'; '+({added:'added to this session',not_added:'not added: it does not validate with the memory',turn_only:'used for this turn'}[sc.status]||sc.status));sopBlock(s.box,'definition',sc.text);}
  field(s.list,'your statements',(c.user_statements||[]).map(x=>x.statement).join(' '));
  if((c.carried_statements||[]).length)field(s.list,'earlier statements',c.carried_statements.map(x=>x.atom).join('; '));
  field(s.list,'assumptions',(c.model_assumptions||[]).map(a=>a.statement+' ['+a.treatment+']').join(' '));
  if((c.model_assumptions||[]).length)field(s.list,'assumption policy',c.assumption_policy);}
 // 4. Linking: the strings of the circuit bound to the memory by the KnowledgeLinker.
 if((c.linking||[]).length){const l=section(details,'4. Linking (KnowledgeLinker)').list;listField(l,'bound',c.linking.map(linkingLine));browseField(l,'in the knowledge browser',c,[...new Map(c.linking.filter(e=>e.symbol&&e.via!=='conversation'&&/^[A-Za-z0-9_]+$/.test(e.symbol)).map(e=>[e.symbol,{kind:e.kind==='predicate'||e.kind==='relation'?'predicate':'entity',id:e.symbol}])).values()]);}
 // 5. Retrieval: the slice of the memory and whether it is complete.
 const rt=c.retrieval;if(rt){const r=section(details,'5. Retrieval (memory slice)').list;
  field(r,'complete',rt.complete===true?'yes':rt.complete===false?'no: the answer is withheld or marked partial':null);field(r,'guard',rt.guard);
  field(r,'slice',(rt.facts??0)+' fact(s), '+(rt.rules??0)+' rule(s), '+(rt.probes??0)+' probe(s)'+(rt.class?', class '+rt.class:''));
  if(rt.predicates)browseField(r,'relations',c,rt.predicates.map(x=>({kind:'predicate',id:String(x).split('/')[0]})));
  if(rt.bound)field(r,'bounds',Object.entries(rt.bound).map(([k,v])=>k+' '+v).join(', '));
  if((rt.reasons||[]).length)field(r,'incomplete because',rt.reasons.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('; '));}
 // 6. Route and verification: the StrategyRouter's engine and the oracle check.
 const ro=c.route;if(ro||c.backend){const r=section(details,'6. Route and verification (StrategyRouter)').list;
  if(ro){field(r,'engine',ro.chosen+(ro.requested&&ro.requested!=='auto'?' (requested '+ro.requested+')':''));field(r,'rule',ro.rule);field(r,'why',ro.reason);}
  field(r,'fallback',c.fallback===null?'none':c.fallback);
  const v=c.verification;field(r,'oracle verification',v?(v.checked?(v.outcome||'checked'):'not checked'+(v.policy?' ('+v.policy+')':''))+(v.reason?': '+v.reason:''):ro&&/^js-/.test(ro.chosen||'')?'the oracle answered itself':'none');
  field(r,'completeness',c.completeness);if(c.reinforcement)field(r,'reinforcement',c.reinforcement);if(c.required)field(r,'needs clarification',c.required);}
 // 7. Answer formulation: the deterministic English answer, and its phrasing in the message's language when that step ran.
 const al=c.answer_language;if(al){const a=section(details,'7. Answer formulation').list;
  field(a,'language step',al.applied?'phrased in the language of your message by '+al.model+' from the result only':'not applied: '+(al.reason||'off'));
  field(a,'mode',al.mode);if((al.tried||[]).length)field(a,'models refused',al.tried.map(t=>t.model+': '+t.reason).join('; '));field(a,'time',secs(al.ms));
  if(al.applied&&c.english_text)field(a,'English answer (deterministic)',c.english_text);}
 // 8. Latency.
 const t=section(details,'8. Latency').list;field(t,'formalization',secs(c.formalization_ms));field(t,'answer formulation',al&&al.ms?secs(al.ms):null);field(t,'whole turn on the server',secs(c.turn_ms));field(t,'round trip in the browser',secs(c.client_ms));
 // Circuits and raw data.
 sopBlock(details,'circuit written by the request parser',c.model_sop);
 sopBlock(details,'execution circuit (generated by the runtime)',c.circuit);
 if(c.provenance&&c.provenance.length)block(details,'provenance (facts used)',c.provenance);
 if(ro)block(details,'route (raw)',ro);
 sopBlock(details,'pending clarification SOP',c.pendingSop);
 return details;
}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
async function api(path,body){
 const t0=performance.now();
 try{const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>null);return {ok:r.ok&&Boolean(j)&&!j.error,status:r.status,body:j,ms:Math.round(performance.now()-t0)};}
 catch{return {ok:false,status:0,body:null,ms:Math.round(performance.now()-t0)};}
}
function add(item){
 const div=document.createElement('div');div.className='msg '+item.role;
 const text=document.createElement('div');text.className='txt';text.textContent=item.text;div.append(text);
 if(item.hint){const hint=document.createElement('div');hint.className='meta';hint.innerHTML=item.hint;div.append(hint);}
 if(item.trace)div.append(traceView(item.trace));
 if(item.time){const meta=document.createElement('div');meta.className='meta';meta.textContent=new Date(item.time).toLocaleTimeString();div.append(meta);}
 // Thumbs up and down on an answered turn of a session (chat-product.mjs feedbackBar, POST /v1/feedback).
 if(typeof feedbackBar==='function')feedbackBar(item,div);
 $('log').append(div);
 return div;
}
function renderLog(){$('log').textContent='';stick=true;const items=transcript(current);if(!items.length){const p=document.createElement('p');p.className='empty';p.textContent='Conversation "'+current+'". '+EXAMPLE;$('log').append(p);}for(const item of items)add(item);scrollBottom(true);}
// The newest message stays in view: while the user is at the bottom the list follows every addition (also the answers filling in later);
// once the user scrolled up it stays put and the "new messages" pill appears.
const logEl=$('log'),hintEl=$('scroll-hint');let stick=true;
const nearBottom=()=>logEl.scrollHeight-logEl.scrollTop-logEl.clientHeight<80;
function scrollBottom(force){if(force)stick=true;if(!stick)return;logEl.scrollTop=logEl.scrollHeight;hintEl.hidden=true;}
const autoScroll=()=>scrollBottom();
// Only a move up by the user releases the follow mode: a late scroll event of our own scroll, after the content grew, must not.
let lastTop=0;
logEl.addEventListener('scroll',()=>{if(nearBottom()){stick=true;hintEl.hidden=true;}else if(logEl.scrollTop<lastTop-1)stick=false;lastTop=logEl.scrollTop;});
new MutationObserver(muts=>{
 if(stick){requestAnimationFrame(()=>scrollBottom());return;}
 if(muts.some(m=>[...m.addedNodes].some(n=>n.parentNode===logEl&&!(n.classList&&n.classList.contains('empty')))))hintEl.hidden=false;
}).observe(logEl,{childList:true,subtree:true,characterData:true});
hintEl.onclick=()=>scrollBottom(true);
function remember(item){const items=transcript(current);items.push(item);saveTranscript(current,items);}
function explain(status,body){
 const message=body&&body.error&&body.error.message;
 if(status===401||status===403)return {text:'You are not signed in (or the session expired).',hint:'<a href="/login?next=%2Fchat">Sign in again</a>'};
 if(status===503)return {text:'No circuit could be written (parse_unavailable), so no answer was produced'+(message?': '+message:'.'),hint:'The chosen formalization strategy or every model of its chain is unavailable. <b>Settings</b> shows the server status; choose another strategy or model there.',trace:body&&body.chatSop};
 if(status===422)return {text:(body&&body.error&&body.error.code==='parse_failed')?'The request parser ran but wrote no valid circuit for this message (parse_failed), so no answer was produced.':'The circuit was not admitted or could not be executed, so no answer was produced.',hint:'The trace shows what was written, the repair rounds and why it was refused. Rephrase the message or try another strategy or model.',trace:body&&body.chatSop};
 if(status===409)return {text:'This conversation is still answering the previous message. Wait for it, or start a new conversation.'};
 if(status===429)return {text:'The server is busy (too many simultaneous requests). Try again in a moment.'};
 if(status===504)return {text:'The answer took too long and was stopped.',hint:'If the message asked to store something, check the result before sending it again.'};
 if(status===413)return {text:'The message is too long for this server.'};
 if(status===400)return {text:message?'The request was refused: '+message:'The request was refused.'};
 if(status===0)return {text:'The server could not be reached. Check the connection and try again.'};
 return {text:'The server answered HTTP '+status+(message?': '+message:'')};
}
async function proceedSend(text,ctx){
 input.value='';fit();scrollBottom(true);
 const conversation=current;
 const user=ctx&&ctx.user?ctx.user:{id:uid(),role:'user',text,time:Date.now()};if(!(ctx&&ctx.user))remember(user);if(!(ctx&&ctx.userDiv))add(user);
 stage('Formalizing with '+(typeof strategyName==='function'?strategyName():'the request parser')+'\u2026');
 const t0=performance.now();
 const waiting=document.createElement('div');waiting.className='msg assistant muted';waiting.textContent='thinking\u2026';$('log').append(waiting);autoScroll();
 let status=0,body=null;
 try{const response=await fetch('/v1/chat/completions',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:(typeof chosenModel==='function'&&chosenModel())||MODEL,messages:[{role:'user',content:text}],conversation_id:conversation,...(typeof sessionBody==='function'?sessionBody():{})})});status=response.status;body=await response.json().catch(()=>null);}
 catch{status=0;}
 waiting.remove();
 const clientMs=Math.round(performance.now()-t0);if(body&&body.chatSop)body.chatSop.client_ms=clientMs;
 const item=status===200&&body&&body.choices?{role:'assistant',text:body.choices[0].message.content,trace:body.chatSop,time:Date.now()}:{role:'assistant error',...explain(status,body),time:Date.now()};
 if(conversation===current){remember(item);add(item);}else{const items=transcript(conversation);items.push(item);saveTranscript(conversation,items);}
 setBusy(false);autoScroll();
}
const input=$('input');
async function send(){
 const text=input.value.trim();if(!text||sending)return;
 setBusy(true,'Working\u2026');scrollBottom(true);
 if(typeof productEarly==='function'&&await productEarly(text)){setBusy(false);return;}
 if(!transcript(current).length)$('log').textContent='';
 await proceedSend(text,null);
}
function newConversation(){const stamp=new Date().toISOString().slice(0,16).replace(/[-:T]/g,'');const id='c'+stamp+'-'+Math.random().toString(36).slice(2,6);conversations.unshift(id);current=id;store.set('chatsop.conversations',conversations.slice(0,50));store.set('chatsop.current',current);renderSelect();renderLog();$('input').focus();}

$('conversation').onchange=e=>{current=e.target.value;store.set('chatsop.current',current);renderLog();};
$('clear').onclick=()=>{saveTranscript(current,[]);renderLog();};
$('send').onclick=send;
// The composer grows to five lines.
function fit(){const t=$('input');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,136)+'px';scrollBottom();}
$('input').addEventListener('input',fit);
$('input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}});
renderSelect();renderLog();
`;
const row = (title, help, control, cls = '') => `<div class="srow${cls ? ' ' + cls : ''}"><div class="what"><b>${title}</b><span>${help}</span></div><div class="ctl">${control}</div></div>`;

export function chatPage({model, ready, codingAgent = null}) {
  const banner = ready ? '' : `<p class="notice bad">The default formalization strategy cannot run${codingAgent?.reason ? ': ' + escapeHtml(codingAgent.reason) : ''}, so chat answers fail with "parse_unavailable" until it can. Settings shows the server status.</p>`;
  const tab = (id, label, selected) => `<button id="tab-${id}" class="tab" role="tab" type="button" aria-selected="${selected}" aria-controls="panel-${id}" tabindex="${selected ? 0 : -1}">${ICONS[id]}<span>${label}</span></button>`;
  const strategyRow = row('<label class="plain" for="formalizer">Formalization strategy</label>', 'Overrides the model\'s formalize strategy for this session ("server default" keeps the model\'s). Who turns your message into a circuit. Strategies this server cannot run are shown disabled with the reason; a chosen strategy is never replaced by another one.', '<select id="formalizer"><option value="">server default</option></select>');

  const body = `<main class="app" data-ready="${ready ? 'yes' : 'no'}">
${banner}
<nav class="tabs" role="tablist" aria-orientation="vertical" aria-label="Chat sections">${tab('chat', 'Chat', true)}${tab('settings', 'Settings', false)}${tab('memory', 'Base Memory', false)}${tab('symbolic', 'Symbolic Models', false)}</nav>
<section id="panel-chat" class="panel" role="tabpanel" aria-labelledby="tab-chat">
${sessionHeadHtml}
<div class="log-wrap"><div id="log" aria-live="polite"></div><button id="scroll-hint" class="pill-btn" type="button" hidden>↓ new messages</button></div>
<div class="composer-wrap">${chipsHtml}<div id="busy" class="busy" role="status" aria-live="polite" hidden><span class="spin" aria-hidden="true"></span><span id="busy-text">Working\u2026</span></div><div id="composer" class="composer"><button id="attach" class="icon-btn" type="button" title="Attach UTF-8 text files (txt, md, sop, csv, json): they go to the coding agent, which writes SOP circuits from them" aria-label="Attach files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-8-8L13 4.5a3.7 3.7 0 0 1 5.3 5.3l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8"/></svg></button>${attachHtml}<textarea id="input" rows="1" placeholder="Type a message" aria-label="Message"></textarea><button id="send" class="icon-btn primary" type="button" title="Send (Enter)" aria-label="Send">${SEND_ICON}</button></div><p class="composer-hint">Enter sends, Shift+Enter adds a new line. Attached files go to the coding agent, which drafts knowledge circuits for you to accept.</p></div>
</section>
<section id="panel-settings" class="panel scroll-panel" role="tabpanel" aria-labelledby="tab-settings" hidden><div class="inner">
<h2>Settings</h2><p class="lead">Choices are remembered in this browser.</p>
<section class="card set"><h3>Formalization</h3><p class="help">The request parser writes a circuit from your message; the symbolic runtime validates it, links it to the base memory, retrieves a slice, routes it to an engine, verifies it with the oracle and renders the answer. The parser never answers and never adds a fact.</p>
${strategyRow}
${settingsModelHtml}
${settingsFormalizerModelHtml}
</section>
<section class="card set"><h3>Server status</h3><p class="help">What this server can run now (<code>GET /v1/status</code>).</p><div class="srow"><div class="what"><b>Status</b><span id="status-when">not read yet</span></div><div class="ctl"><button id="status-refresh" type="button">Refresh</button></div></div><div id="status-box"></div></section>
</div></section>
<section id="panel-memory" class="panel scroll-panel" role="tabpanel" aria-labelledby="tab-memory" hidden><div class="inner">
${memoryTabHtml}
</div></section>
<section id="panel-symbolic" class="panel scroll-panel" role="tabpanel" aria-labelledby="tab-symbolic" hidden><div class="inner">
${symbolicTabHtml}
</div></section>
${productDialogsHtml}
</main>`;
  return layout({title: 'MRP-LLM chat', active: 'chat', signedIn: true, body, script: sopCodeScript + '\n' + script + '\n' + productScript + '\n' + symbolicScript, style: SOP_CODE_STYLE + CHAT_STYLE + SYMBOLIC_STYLE}).replace('<body>', `<body data-model="${escapeHtml(model)}">`);
}
