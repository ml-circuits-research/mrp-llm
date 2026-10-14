/** The product layer of the chat page (DS022, DS009 "The chat page"): sessions, base memories and knowledge authoring.
 *
 * - The *session header* of the Chat tab shows the session of the current conversation (its base memory, strategy and circuits)
 *   with *New session* (opens the start dialog where the base memory is chosen from `GET /v1/memories`) and *Commit*. Every
 *   conversation is bound to a server session (`POST /v1/sessions`); the chat request carries `session_id`.
 * - The *Base Memory* tab lists the memories (name, strategy, size, created, parent) with View (manifest, counts, sample wires), Fork
 *   (name and strategy), Add knowledge (paste or upload a circuit; validation problems are shown, nothing is written on failure) and
 *   Start session; creating an empty memory is there too. Every signed-in user may use them (no admin role yet).
 * - Settings, *Formalization*: the formalization strategy of the session (session setting `formalizer`; strategies the server cannot run
 *   are disabled with the reason, from `GET /v1/status`) and the first tier (session setting `formalizer_model`: the proxy tier of the
 *   ladder the step-by-step questions start at, from `GET /v1/status`; the ladder continues upward from it). *Server status*: strategies, base
 *   memories with their warm state, and the reasoning engines (`GET /v1/status`). A message goes to `POST /v1/chat/completions`;
 *   attached files go to knowledge authoring (`POST /v1/author`).
 * - Authoring progress (`POST /v1/author` with `wait: false`, polled) and the authored circuits (validation, report, cost) are shown as a
 *   card in the conversation; validated circuits join the session layer at once (no manual acceptance, owner 2026-10-02).
 * All dynamic text is inserted with textContent; the page never builds markup from server data.
 */

export const sessionHeadHtml = `<header class="chat-head"><div class="info" id="session-info" aria-label="Session and base memory">Loading the session…</div><div class="btns"><label for="conversation" class="muted" style="margin:0;font-weight:400;font-size:13px">Chat</label><select id="conversation" title="Earlier conversations in this browser"></select><button id="new" type="button" aria-label="New conversation (new session)" title="Start a new conversation on a base memory of your choice">New session</button><button id="commit-open" type="button" title="Commit the circuits accepted in this session to a new base memory">Commit…</button><button id="clear" type="button" title="Clears only this browser's copy of the transcript; the server keeps the conversation context">Clear view</button></div></header>`;

const srow = (title, help, control) => `<div class="srow"><div class="what"><b>${title}</b><span>${help}</span></div><div class="ctl">${control}</div></div>`;
export const settingsModelHtml = [
  srow('<label class="plain" for="mrp-model">Model</label>', 'The MRP-LLM model you talk to: a knowledge base plus the strategies of every pipeline slot (configured on <a href="/models">Models</a>). Changing it starts a new session on that model.', '<select id="mrp-model"><option value="">server default</option></select>'),
  '<p id="mrp-model-note" class="hint-note"></p>',
  srow('<label class="plain" for="mrp-language">Answer language</label>', 'Everything inside runs in English; the voice slot phrases the answer in this language. Same as my message: the language you write in.', '<select id="mrp-language"><option value="">the model\'s setting</option><option value="auto">same as my message</option><option value="en">English</option><option value="ro">Romanian</option><option value="fr">French</option><option value="de">German</option><option value="es">Spanish</option><option value="it">Italian</option><option value="pt">Portuguese</option><option value="hu">Hungarian</option><option value="pl">Polish</option><option value="ru">Russian</option><option value="uk">Ukrainian</option></select>'),
].join('');

export const settingsFormalizerModelHtml = [
  srow('<label class="plain" for="formalizer-model">First tier</label>', 'Overrides the tier of the model\'s formalize slot for this session. The proxy tier that answers the step-by-step questions first; a question goes up the ladder only when its answer cannot be read.', '<select id="formalizer-model"><option value="">no preference: the configured ladder</option></select>'),
  '<p id="formalizer-model-note" class="hint-note"></p>',
  srow('<label class="plain" for="adapter-mode">Answer mode</label>', 'Overrides the model\'s formalize strategy for this session. How the symbolic core answers: step by step (the formalizer\'s questions), routed (several formalizations; two that agree verify the answer), or direct-verified (the model answers, the formalizations try to verify it). Every answer says whether it was verified.', '<select id="adapter-mode"><option value="">server default</option><option value="stepwise">step by step</option><option value="routed">routed</option><option value="direct-verified">direct, verified</option></select>'),
].join('');

export const memoryTabHtml = `<h2>Base Memory</h2><p class="lead">Every session is a fork of a base memory. The default is the encyclopedic world-v1, which gives a session common sense and basic knowledge; minimal or empty memories serve specialised tasks. What a chat adds stays in the session until you commit it into a new base memory.</p>
<div class="mem-top"><button id="mem-new" type="button" title="Create a base memory: encyclopedic, minimal or empty">Create memory…</button><button id="mem-refresh" type="button">Reload</button><span class="spacer"></span><span id="mem-count" class="state"></span></div>
<div id="mem-msg" class="msgline" role="status"></div>
<table class="mem" aria-label="Base memories"><thead><tr><th>Name</th><th>Strategy</th><th>Size</th><th>Created</th><th>Parent</th><th>Actions</th></tr></thead><tbody id="mem-rows"><tr><td colspan="6">Loading…</td></tr></tbody></table>`;

export const productDialogsHtml = `
<dialog id="start-dialog" aria-labelledby="start-title"><h2 id="start-title">New session</h2>
<p class="msgline">A session talks to one Symbolic Model and works on its own copy of the model's knowledge (the base memories chosen for the model in the Symbolic Models tab). What the conversation adds stays in the session until it is committed.</p>
<div class="row"><label for="start-base">Symbolic Model</label><select id="start-base"></select></div>
<div id="start-detail" class="msgline"></div>
<div class="row"><label for="start-name">Session name</label><input type="text" id="start-name" maxlength="120" placeholder="optional"></div>
<div id="start-error" class="msgline bad" hidden></div>
<div class="actions"><button id="start-cancel" type="button">Cancel</button><button id="start-go" type="button" class="primary">Start session</button></div></dialog>
<dialog id="view-dialog" aria-labelledby="view-title"><h2 id="view-title">Base memory</h2><div id="view-body"></div><div class="actions"><button id="view-close" type="button">Close</button></div></dialog>
<dialog id="fork-dialog" aria-labelledby="fork-title"><h2 id="fork-title">Fork</h2><p class="msgline">Same strategy: a copy-on-write clone. Another strategy: the knowledge files are replayed into the new engine.</p>
<div class="row"><label for="fork-name">Name</label><input type="text" id="fork-name" maxlength="120" placeholder="name of the fork"></div><div class="row"><label for="fork-strategy">Strategy</label><select id="fork-strategy"></select></div>
<div id="fork-msg" class="msgline" role="status"></div><div class="actions"><button id="fork-cancel" type="button">Close</button><button id="fork-go" type="button" class="primary">Fork</button></div></dialog>
<dialog id="know-dialog" aria-labelledby="know-title"><h2 id="know-title">Add knowledge</h2><p class="msgline">Paste SOP text or load a .sop knowledge file. It is validated first; nothing is written when a problem is found.</p>
<div class="row"><label for="know-name">File name</label><input type="text" id="know-name" maxlength="80" value="circuit"><input type="file" id="know-file" accept=".sop,.txt,text/plain" aria-label="Load a knowledge file"></div>
<textarea id="know-text" placeholder="Knowledge wires, for example:&#10;@parent predicate&#10;  args subject:entity object:entity&#10;@f1 fact&#10;  holds parent ann bob&#10;  source &quot;demo&quot;" aria-label="Circuit text"></textarea>
<div class="row"><label for="know-reason">Reason</label><input type="text" id="know-reason" maxlength="200" placeholder="why it is added"></div>
<div id="know-msg" class="msgline" role="status"></div><div class="actions"><button id="know-cancel" type="button">Close</button><button id="know-go" type="button" class="primary">Validate and add</button></div></dialog>
<dialog id="new-dialog" aria-labelledby="new-title"><h2 id="new-title">Create a base memory</h2>
<div class="row"><label for="new-name">Name</label><input type="text" id="new-name" maxlength="120"></div><div class="row"><label for="new-kind">Built on</label><select id="new-kind"><option value="encyclopedic">encyclopedic: a fork of world-v1 (common sense and basic knowledge)</option><option value="minimal" selected>minimal: the core vocabulary (core-min)</option><option value="empty">empty: nothing, for a specialised task</option></select></div><div class="row"><label for="new-strategy">Strategy</label><select id="new-strategy"></select></div>
<div id="new-msg" class="msgline" role="status"></div><div class="actions"><button id="new-cancel" type="button">Close</button><button id="new-go" type="button" class="primary">Create</button></div></dialog>
<dialog id="commit-dialog" aria-labelledby="commit-title"><h2 id="commit-title">Commit the session to a base memory</h2>
<p class="msgline">Creates a new base memory: a fork of the session's base memory plus the knowledge files added in this session, validated again. The original base memory does not change. Recorded with provenance.</p>
<div class="row"><label for="commit-name">Name</label><input type="text" id="commit-name" maxlength="120"><label for="commit-strategy">Strategy</label><select id="commit-strategy"></select></div>
<div id="commit-msg" class="msgline" role="status"></div>
<div class="actions"><button id="commit-cancel" type="button">Cancel</button><button id="commit-go" type="button" class="primary">Commit</button></div></dialog>
<dialog id="fb-dialog" aria-labelledby="fb-title"><h2 id="fb-title">What was wrong with this answer?</h2>
<fieldset><legend class="msgline">Choose one cause</legend>
<label><input type="radio" name="fb-cause" value="not_understood"><span><b>Did not understand my request</b></span></label>
<label><input type="radio" name="fb-cause" value="wrong_answer"><span><b>Wrong answer</b> <span class="muted">(the reasoning or the facts are wrong)</span></span></label>
<label><input type="radio" name="fb-cause" value="missing_knowledge"><span><b>Missing knowledge</b> <span class="muted">(it should know this)</span></span></label>
<label><input type="radio" name="fb-cause" value="unnecessary_question"><span><b>Unnecessary question or clarification</b> <span class="muted">(the request was clear)</span></span></label>
<label><input type="radio" name="fb-cause" value="bad_wording"><span><b>Bad wording or tone</b> <span class="muted">(correct, but phrased badly)</span></span></label>
</fieldset>
<textarea id="fb-comment" maxlength="2000" placeholder="Comment (optional)" aria-label="Comment (optional)"></textarea>
<div id="fb-msg" class="msgline bad" role="status"></div>
<div class="actions"><button id="fb-cancel" type="button">Cancel</button><button id="fb-send" type="button" class="primary">Send</button></div></dialog>`;

export const attachHtml = `<input type="file" id="attach-file" multiple hidden>`;
export const chipsHtml = `<div id="chips" class="chips" aria-label="Attached files"></div>`;

export const productScript = String.raw`
// ---- product layer (DS022): sessions, base memories, knowledge authoring ----
const PROD={session:null,memories:[],strategies:[],files:[]};
async function jcall(method,path,body){
 try{const r=await fetch(path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}
  return {ok:r.ok&&Boolean(j)&&!j.error,status:r.status,body:j,error:j&&j.error?j.error:null};}
 catch{return {ok:false,status:0,body:null,error:{message:'The server could not be reached.'}};}
}
const errText=r=>r.error?r.error.message+(r.error.problems?' ('+r.error.problems.length+' problem'+(r.error.problems.length===1?'':'s')+')':''):'HTTP '+r.status;
function problemList(problems){const ul=el('ul','problems');for(const p of problems||[]){ul.append(el('li','',(p.file?p.file+(p.line?':'+p.line:'')+' ':'')+p.code+(p.wire?' (@'+p.wire+')':'')+': '+p.message));}return ul;}
// Every signed-in user may fork, extend and commit base memories (owner decision 2026-10-01: no admin role yet), so no control is gated.
const sessionMap=()=>store.get('chatsop.sessionOf',{});
const boundSession=()=>sessionMap()[current]||null;
function bindSession(id){const m=sessionMap();m[current]=id;store.set('chatsop.sessionOf',m);}
function sessionBody(){return PROD.session?{session_id:PROD.session.id}:{};}
function renderSessionBar(){
 const info=$('session-info');info.textContent='';const s=PROD.session;
 if(!s){info.textContent='No session yet.';return;}
 const mid=s.settings&&s.settings.model;
 info.append(el('b','',s.name||s.id),document.createTextNode(' \u00b7 '+(mid?'model ':'')),...(mid?[el('b','',(PROD.models.find(m=>m.id===mid)||{name:mid}).name||mid),document.createTextNode(' \u00b7 ')]:[]),document.createTextNode('base memory '),el('b','',s.base.name));
 if(s.settings&&s.settings.language)info.append(el('span','pill','answers: '+s.settings.language));
 info.append(el('span','pill accent',s.base.strategy));
 const accepted=(s.circuits||[]).length;
 info.append(el('span','pill',s.sop_wires==null?plural(accepted,'knowledge file added','knowledge files added'):sizeText(s)+(accepted?' ('+accepted+' added in this session)':'')));info.lastChild.title=sizeTitle(s);
 if((s.committed_to||[]).length)info.append(el('span','pill ok','committed'));
 info.title='session '+s.id;
 info.append(el('span','pill',strategyName()));
 if($('formalizer'))$('formalizer').value=(s.settings&&s.settings.formalizer)||'';
 const model=(s.settings&&(s.settings.formalizer_model||s.settings.omp_model))||'';if([...$('formalizer-model').options].some(o=>o.value===model))$('formalizer-model').value=model;
 if($('adapter-mode'))$('adapter-mode').value=(s.settings&&s.settings.adapter_mode)||'';
 $('commit-open').disabled=!accepted;
 if($('mem-rows')&&!$('panel-memory').hidden)renderMemoryRows();
}
async function refreshSession(){
 if(!PROD.session)return;const r=await jcall('GET','/v1/sessions/'+PROD.session.id);
 if(r.ok)PROD.session=r.body;renderSessionBar();
}
async function startSession(baseId,name){
 const r=await jcall('POST','/v1/sessions',{...(baseId?{base:baseId}:{}),...(name?{name}:{}),settings:{formalizer_model:store.get('chatsop.formalizerModel',null),formalizer:store.get('chatsop.formalizer',null),adapter_mode:store.get('chatsop.adapterMode',null),model:chosenModel(),language:store.get('mrp.language',null)}});
 if(!r.ok)return r;
 PROD.session=r.body;bindSession(r.body.id);if(baseId)store.set('chatsop.lastBase',baseId);renderSessionBar();return r;
}
async function ensureSession(){
 const id=boundSession();
 // A remembered session of another model is not reused: the model decides the base memory and the strategies.
 if(id){const r=await jcall('GET','/v1/sessions/'+id);if(r.ok&&((r.body.settings&&r.body.settings.model)||null)===chosenModel()){PROD.session=r.body;renderSessionBar();return PROD.session;}}
 PROD.session=null;renderSessionBar();
 // Without a remembered choice the server forks its default base memory (the encyclopedic world-v1 when loaded).
 let r=await startSession(chosenModel()?null:store.get('chatsop.lastBase',null));
 if(!r.ok)r=await startSession(null);
 if(!r.ok)$('session-info').textContent='No session: '+errText(r);
 return PROD.session;
}
async function loadMemories(){const r=await jcall('GET','/v1/memories');if(r.ok){PROD.memories=r.body.data;PROD.strategies=r.body.strategies;PROD.defaultBase=r.body.default_base;}return r;}
function fillStrategies(select,selected){select.textContent='';for(const s of PROD.strategies){const o=document.createElement('option');o.value=s.id;o.textContent=s.id;o.title=s.note;select.append(o);}if(selected)select.value=selected;}
const WIRE_TYPE_NAMES={fact:'facts',rule:'rules',entity:'entities',predicate:'predicates',lexeme:'lexemes',default:'defaults',integrity:'integrity rules'};
const nf=n=>Number(n).toLocaleString('en-US');
const plural=(n,one,many)=>nf(n)+' '+(n===1?one:many);
// "N knowledge files \u00b7 M SOP wires" (the stored-facts index is a secondary number, see sizeTitle).
const sizeText=m=>m.sop_wires==null?plural(m.circuits,'knowledge file','knowledge files'):plural(m.knowledge_files,'knowledge file','knowledge files')+' \u00b7 '+plural(m.sop_wires,'SOP wire','SOP wires');
// Wires by type, larger groups first; types without a plain name are grouped as "other".
function wireBreakdown(m){const by=m.wires_by_type||{};const named=[];let other=0;for(const [t,n] of Object.entries(by)){if(WIRE_TYPE_NAMES[t])named.push([WIRE_TYPE_NAMES[t],n]);else other+=n;}if(other)named.push(['other',other]);return named.map(([k,n])=>nf(n)+' '+k).join(', ');}
const sizeTitle=m=>(m.facts==null?'':nf(m.facts)+' facts in the store (an index for fast lookup). ')+(wireBreakdown(m)?'SOP wires: '+wireBreakdown(m)+'.':'');
const memLabel=m=>m.name+(m.id===PROD.defaultBase?' (default)':'')+' \u00b7 '+sizeText(m);

// ---- new session dialog
function showStartDetail(){
 const box=$('start-detail');box.textContent='';
 if(PROD.models.length){const sm=PROD.models.find(x=>x.id===$('start-base').value);if(!sm)return;const mem=(sm.memories||[sm.base]).map(id=>(PROD.memories.find(x=>x.id===id)||{name:id}).name).join(', ');box.append(document.createTextNode((sm.description||'No description.')+' Knowledge: '+mem+'.'));return;}
 const m=PROD.memories.find(x=>x.id===$('start-base').value);if(!m)return;
 box.append(document.createTextNode((m.description||'No description.')+' '+sizeText(m)+(wireBreakdown(m)?' ('+wireBreakdown(m)+')':'')+', strategy '+m.strategy+(m.parent?', forked from '+m.parent.name:'')+'.'));
}
async function openStart(baseId){
 await loadMemories();const select=$('start-base');select.textContent='';
 // With Symbolic Models the dialog chooses one of them (its knowledge is configured on the model); without them, a base memory.
 if(PROD.models.length){const r=await jcall('GET','/v1/mrp/models');if(r.ok)for(const m of r.body.data){const x=PROD.models.find(y=>y.id===m.id);if(x){x.memories=m.memories;x.base=m.base;}}
  for(const m of PROD.models){const o=document.createElement('option');o.value=m.id;o.textContent=m.name+(m.id===PROD.defaultModel?' (default)':'');select.append(o);}select.value=chosenModel()||'';}
 else{for(const m of PROD.memories){const o=document.createElement('option');o.value=m.id;o.textContent=memLabel(m);select.append(o);}
 select.value=baseId||store.get('chatsop.lastBase',null)||PROD.defaultBase||'';}
 if(!select.value&&select.options.length)select.selectedIndex=0;
 $('start-error').hidden=true;$('start-name').value='';showStartDetail();$('start-dialog').showModal();
}
$('start-base').onchange=showStartDetail;
$('start-cancel').onclick=()=>$('start-dialog').close();
$('start-dialog').addEventListener('close',()=>{if(!boundSession())ensureSession();});
$('start-go').onclick=async()=>{
 let r;
 if(PROD.models.length){store.set('mrp.model',$('start-base').value);if($('mrp-model'))$('mrp-model').value=$('start-base').value;r=await startSession(null,$('start-name').value.trim());}
 else r=await startSession($('start-base').value,$('start-name').value.trim());
 if(!r.ok){$('start-error').hidden=false;$('start-error').textContent=errText(r);return;}
 $('start-dialog').close();
};
// A new conversation asks which base memory its session starts from.
$('new').onclick=()=>{newConversation();PROD.session=null;renderSessionBar();switchTab('chat');openStart();};
$('conversation').addEventListener('change',()=>{ensureSession();});

// ---- base memory tab
function dlg(id){const d=$(id);return d;}
const closeBtn=(btn,id)=>{$(btn).onclick=()=>$(id).close();};
function setMsg(id,text,cls){const m=$(id);m.textContent=text||'';m.className='msgline'+(cls?' '+cls:'');return m;}
const day=iso=>iso?String(iso).slice(0,10):'';

const plainBtn=(label,tip,fn,cls)=>{const b=el('button',cls||'',label);b.type='button';b.title=tip;b.onclick=fn;return b;};
function renderMemoryRows(){
 const body=$('mem-rows');body.textContent='';
 $('mem-count').textContent=PROD.memories.length+' base memor'+(PROD.memories.length===1?'y':'ies');
 for(const m of PROD.memories){
  const tr=document.createElement('tr');if(PROD.session&&PROD.session.base.id===m.id)tr.className='current';
  const cell=(l,text,cls)=>{const td=el('td',cls||'',text);td.dataset.l=l;tr.append(td);return td;};
  cell('Name',m.name+(m.id===PROD.defaultBase?' (default)':''),'name').title=m.description||m.id;
  cell('Strategy',m.strategy);
  cell('Size',sizeText(m)).title=sizeTitle(m);
  cell('Created',day(m.created_at));
  cell('Parent',m.parent?m.parent.name:'\u2014');
  const acts=cell('','','acts');
  acts.append(plainBtn('View','Manifest, counts and sample wires',()=>openView(m.id)),
   plainBtn('Fork','Fork this memory under a new name and strategy',()=>openFork(m)),
   plainBtn('Add knowledge','Validate and add SOP knowledge files to this memory',()=>openKnow(m)),
   ...(PROD.models.length?[]:[plainBtn('Start session','Start a new chat session on a copy of this base memory',()=>startFromMemory(m.id),'primary')]));
  body.append(tr);
 }
 if(!PROD.memories.length){const tr=document.createElement('tr');const td=el('td','','No base memory yet.');td.colSpan=6;tr.append(td);body.append(tr);}
}
async function renderMemories(){
 const r=await loadMemories();
 if(!r.ok){$('mem-rows').textContent='';const tr=document.createElement('tr');const td=el('td','msgline bad','The base memories could not be read: '+errText(r));td.colSpan=6;tr.append(td);$('mem-rows').append(tr);return;}
 renderMemoryRows();
}
$('mem-refresh').onclick=()=>{setMsg('mem-msg','');renderMemories();};
async function startFromMemory(id){
 newConversation();PROD.session=null;renderSessionBar();
 const r=await startSession(id);
 if(!r.ok){setMsg('mem-msg','The session could not be started: '+errText(r),'bad');return;}
 switchTab('chat');
}
async function openView(id){
 const box=$('view-body');box.textContent='Loading\u2026';$('view-dialog').showModal();
 const r=await jcall('GET','/v1/memories/'+encodeURIComponent(id)+'?facts=1');box.textContent='';
 if(!r.ok){box.append(el('p','msgline bad',errText(r)));return;}
 const m=r.body;$('view-title').textContent=m.name;const dl=document.createElement('dl');
 field(dl,'id',m.id);field(dl,'strategy',m.strategy);field(dl,'created',m.created_at);field(dl,'parent',m.parent?m.parent.name+' ('+m.parent.id+', '+m.parent.strategy+', forked '+m.parent.forked_at+')':'none');
 field(dl,'knowledge',sizeText(m)+((m.circuit_files||[]).length?' (own files: '+m.circuit_files.join(', ')+')':''));field(dl,'SOP wires by type',wireBreakdown(m)||'none');field(dl,'facts in the store (index for fast lookup)',m.facts);field(dl,'description',m.description);box.append(dl);
 const facts=Object.entries(m.stored_facts||{}).filter(([,rows])=>rows.length);
 if(facts.length){const d=el('details');d.open=true;d.append(el('summary','','sample wires ('+facts.reduce((n,[,rows])=>n+rows.length,0)+' stored facts)'));d.append(el('pre','',facts.map(([pred,rows])=>rows.slice(0,40).map(x=>pred+' '+x.args.join(' ')).join('\n')).join('\n')));box.append(d);}
 else box.append(el('p','msgline','No stored fact yet.'));
 if((m.provenance||[]).length){const d=el('details');d.append(el('summary','','provenance ('+m.provenance.length+' latest)'));d.append(el('pre','',m.provenance.map(x=>(x.approved_at||x.at||'')+' '+x.kind+(x.approved_by?' by '+x.approved_by:'')+(x.file?' '+x.file:'')+(x.reason?' ('+x.reason+')':'')+(x.method?' '+x.method:'')).join('\n')));box.append(d);}
}
closeBtn('view-close','view-dialog');closeBtn('fork-cancel','fork-dialog');closeBtn('know-cancel','know-dialog');closeBtn('new-cancel','new-dialog');
let memCurrent=null;
function openFork(m){memCurrent=m;$('fork-title').textContent='Fork "'+m.name+'"';fillStrategies($('fork-strategy'),m.strategy);$('fork-name').value='';setMsg('fork-msg','');$('fork-dialog').showModal();}
$('fork-go').onclick=async()=>{
 const name=$('fork-name').value.trim();if(!memCurrent||!name){setMsg('fork-msg','Name the fork first.','bad');return;}
 const r=await jcall('POST','/v1/memories/'+encodeURIComponent(memCurrent.id)+'/fork',{name,strategy:$('fork-strategy').value});
 if(!r.ok){setMsg('fork-msg',errText(r),'bad');return;}
 setMsg('fork-msg','Forked as "'+r.body.memory.name+'" ('+r.body.memory.strategy+', '+(r.body.method==='clone'?'copy-on-write clone':'knowledge files replayed into the new engine')+').','ok');
 $('fork-name').value='';renderMemories();
};
function openKnow(m){memCurrent=m;$('know-title').textContent='Add knowledge to "'+m.name+'"';$('know-text').value='';$('know-reason').value='';setMsg('know-msg','');$('know-dialog').showModal();}
$('know-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;$('know-text').value=await f.text();$('know-name').value=f.name.replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9_-]+/g,'-')||'circuit';};
$('know-go').onclick=async()=>{
 const text=$('know-text').value;if(!memCurrent||!text.trim()){setMsg('know-msg','Paste or load SOP text first.','bad');return;}
 const r=await jcall('POST','/v1/memories/'+encodeURIComponent(memCurrent.id)+'/knowledge',{circuits:[{name:$('know-name').value.trim()||'circuit',text}],reason:$('know-reason').value.trim()});
 if(!r.ok){const box=setMsg('know-msg','Not added: '+errText(r),'bad');if(r.error&&r.error.problems)box.append(problemList(r.error.problems));return;}
 const a=r.body.added[0];setMsg('know-msg','Added '+a.file+': '+a.ingest.facts_ingested+' of '+a.ingest.facts_in_circuit+' fact(s) in the memory store, provenance recorded ('+a.approved_by+').'+(r.body.warnings.length?' '+r.body.warnings.length+' warning(s).':''),'ok');
 $('know-text').value='';renderMemories();
};
$('mem-new').onclick=()=>{fillStrategies($('new-strategy'));$('new-name').value='';setMsg('new-msg','');$('new-dialog').showModal();};
$('new-go').onclick=async()=>{
 const name=$('new-name').value.trim();if(!name){setMsg('new-msg','Name the memory first.','bad');return;}
 const r=await jcall('POST','/v1/memories',{name,strategy:$('new-strategy').value,kind:$('new-kind').value});
 if(!r.ok){setMsg('new-msg',errText(r),'bad');return;}
 setMsg('new-msg','Created "'+r.body.name+'".','ok');$('new-name').value='';renderMemories();
};

// ---- authored circuits
function circuitCard(res){
 const card=el('fieldset');card.append(el('legend','',(res.model?res.model:'authoring model')));
 const ok=Boolean(res.added);card.append(el('span','pill '+(ok?'ok':'warn'),ok?'added to this session':'not added'));
 if(res.not_added)card.append(problemList(res.not_added));
 else if(res.validation&&!res.validation.ok)card.append(problemList(res.validation.problems));
 for(const c of res.circuits||[])card.append(el('pre','',c.text));
 if(res.queries){const q=el('details');q.append(el('summary','','test queries'),el('pre','',res.queries));card.append(q);}
 if(res.report){const q=el('details');q.append(el('summary','','agent report'),el('pre','',res.report));card.append(q);}
 return card;
}

// ---- commit to a fork
$('commit-open').onclick=()=>{if(!PROD.session||$('commit-open').disabled)return;fillStrategies($('commit-strategy'),PROD.session.base.strategy);$('commit-name').value='';$('commit-msg').textContent='';$('commit-dialog').showModal();};
$('commit-cancel').onclick=()=>$('commit-dialog').close();
$('commit-go').onclick=async()=>{
 const name=$('commit-name').value.trim();const box=$('commit-msg');box.textContent='';box.className='msgline';
 if(!name){box.className='msgline bad';box.textContent='Name the new base memory first.';return;}
 const r=await jcall('POST','/v1/sessions/'+PROD.session.id+'/commit',{name,strategy:$('commit-strategy').value});
 if(!r.ok){box.className='msgline bad';box.textContent='Not committed: '+errText(r);if(r.error&&r.error.problems)box.append(problemList(r.error.problems));return;}
 box.className='msgline ok';box.textContent='Committed: new base memory "'+r.body.memory.name+'" ('+r.body.memory.strategy+', '+sizeText(r.body.memory)+').';await refreshSession();
};

// ---- the first tier of the step-by-step ladder (GET /v1/status)
function renderModelOptions(){
 const select=$('formalizer-model'),st=PROD.status;if(!st)return;
 const steps=st.formalization.strategies.find(x=>x.available)||st.formalization.strategies[0];const tiers=(steps&&steps.ladder)||[];
 const keep=select.value||(PROD.session&&PROD.session.settings&&PROD.session.settings.formalizer_model)||'';select.textContent='';
 const def=document.createElement('option');def.value='';def.textContent='no preference: the configured ladder'+(tiers.length?' ('+tiers.join(' \u2192 ')+')':'');select.append(def);
 for(const t of tiers){const o=document.createElement('option');o.value=t;o.textContent=t;select.append(o);}
 if([...select.options].some(o=>o.value===keep))select.value=keep;
 $('formalizer-model-note').textContent=steps&&!steps.available?'The formalizer cannot run now: '+(steps.reason||'the first tier is not reachable')+'.':'';
}
// ---- MRP model and answer language (GET /v1/models; session settings model and language)
PROD.models=[];
function chosenModel(){const m=store.get('mrp.model',null);return m&&PROD.models.some(x=>x.id===m)?m:(PROD.defaultModel||null);}
async function loadModels(){
 const r=await jcall('GET','/v1/models');if(!r.ok)return;
 PROD.models=(r.body.data||[]).filter(m=>m.owned_by==='mrp-llm'&&m.mrp&&m.mrp.base).map(m=>({id:m.id,name:m.mrp.name,description:m.mrp.description}));PROD.defaultModel=PROD.models.some(m=>m.id===r.body.default)?r.body.default:null;
 const sel=$('mrp-model');sel.textContent='';for(const m of PROD.models){const o=document.createElement('option');o.value=m.id;o.textContent=m.name+(m.id===PROD.defaultModel?' (default)':'');o.title=m.description||'';sel.append(o);}
 sel.value=chosenModel()||'';$('mrp-model-note').textContent=(PROD.models.find(m=>m.id===sel.value)||{}).description||'';
 $('mrp-language').value=store.get('mrp.language',null)||'';
}
$('mrp-model').onchange=async e=>{store.set('mrp.model',e.target.value||null);$('mrp-model-note').textContent=(PROD.models.find(m=>m.id===e.target.value)||{}).description||'';PROD.session=null;await startSession(null);};
$('mrp-language').onchange=e=>{const v=e.target.value||null;store.set('mrp.language',v);saveSetting({language:v});};
async function saveSetting(patch){
 if('formalizer_model' in patch)store.set('chatsop.formalizerModel',patch.formalizer_model);
 if('formalizer' in patch)store.set('chatsop.formalizer',patch.formalizer);
 if('adapter_mode' in patch)store.set('chatsop.adapterMode',patch.adapter_mode);
 if(!PROD.session)return;const r=await jcall('POST','/v1/sessions/'+PROD.session.id+'/settings',patch);if(r.ok){PROD.session=r.body;renderSessionBar();}
}
$('formalizer-model').onchange=e=>saveSetting({formalizer_model:e.target.value||null});
$('formalizer').onchange=e=>saveSetting({formalizer:e.target.value||null});
if($('adapter-mode'))$('adapter-mode').onchange=e=>saveSetting({adapter_mode:e.target.value||null});

// ---- server status (GET /v1/status): formalization strategies, base memories, engines
PROD.status=null;
function strategyName(){const s=PROD.session&&PROD.session.settings&&PROD.session.settings.formalizer;return s||(PROD.status?PROD.status.formalization.default:'the request parser');}
function renderStrategies(){
 const select=$('formalizer'),st=PROD.status;if(!st)return;const keep=(PROD.session&&PROD.session.settings&&PROD.session.settings.formalizer)||'';select.textContent='';
 const def=document.createElement('option');def.value='';def.textContent='server default ('+st.formalization.default+')';select.append(def);
 for(const s of st.formalization.strategies){const o=document.createElement('option');o.value=s.id;o.textContent=s.id+(s.available?'':' — '+(s.reason||'not available'));o.disabled=!s.available&&s.id!==keep;select.append(o);}
 select.value=keep;
}
function renderStatus(){
 const box=$('status-box'),st=PROD.status;box.textContent='';if(!st)return;
 $('status-when').textContent=(st.ready?'ready':'not ready')+' · up '+Math.round(st.uptime_s/60)+' min · read '+new Date().toLocaleTimeString();
 const table=(head,rows)=>{const t=el('table','mem');const h=document.createElement('tr');for(const x of head)h.append(el('th','',x));const th=document.createElement('thead');th.append(h);const tb=document.createElement('tbody');for(const r of rows){const tr=document.createElement('tr');r.forEach((x,i)=>{const td=el('td','',x);td.dataset.l=head[i];tr.append(td);});tb.append(tr);}t.append(th,tb);return t;};
 box.append(el('h4','','Formalization strategies'),table(['Strategy','State','Backend','Models'],st.formalization.strategies.map(s=>[s.id+(s.id===st.formalization.default?' (default)':''),s.available?'available':(s.reason||'not available'),s.backend||'',(s.models||[]).map(m=>m.id+(m.available===false?' (unavailable)':'')).join(' → ')+(s.endpoint?' '+s.endpoint:'')])));
 box.append(el('h4','','Base memories'),table(['Memory','Facts','Warm'],st.memories.map(m=>[m.name+' ('+m.id+')',String(m.facts??''),m.warm?(m.warm.skipped?'skipped: '+m.warm.skipped:'warm, '+(m.warm.ms/1000).toFixed(1)+' s, '+m.warm.layers+' layers'):'loads on first use'])));
 box.append(el('h4','','Reasoning engines'),el('p','msgline',st.reasoning.router+'; oracle '+st.reasoning.oracle+'; '+st.reasoning.engines.map(e=>e.id+(e.available?'':' (not installed)')).join(', ')));
}
async function loadStatus(){const r=await jcall('GET','/v1/status');if(!r.ok){$('status-when').textContent='The status could not be read: '+errText(r);return;}PROD.status=r.body;renderStrategies();renderStatus();renderModelOptions();renderSessionBar();}
$('status-refresh').onclick=()=>loadStatus();

// ---- attachments
const MAX_FILES=10,MAX_BYTES=2000000;
function renderChips(){
 const box=$('chips');box.textContent='';
 PROD.files.forEach((f,i)=>{const c=el('span','chip');c.append(el('span','',f.name+' ('+Math.ceil(f.text.length/1024)+' KB)'));const x=el('button','','×');x.type='button';x.setAttribute('aria-label','Remove '+f.name);x.onclick=()=>{PROD.files.splice(i,1);renderChips();};c.append(x);box.append(c);});
}
$('attach').onclick=()=>$('attach-file').click();
$('attach-file').onchange=async e=>{
 for(const f of e.target.files){
  if(PROD.files.length>=MAX_FILES){break;}
  if(f.size>MAX_BYTES){add({role:'assistant error',text:'The file '+f.name+' is larger than 2 MB and was not attached.',time:Date.now()});continue;}
  const text=await f.text();
  if(text.includes('\u0000')){add({role:'assistant error',text:'The file '+f.name+' is not UTF-8 text and was not attached (attach txt, md, sop, csv, json or html files).',time:Date.now()});continue;}
  PROD.files.push({name:f.name,text});
 }
 e.target.value='';renderChips();
};

// ---- knowledge authoring (POST /v1/author: a model of the chain called directly)
function agentBlock(model){
 const div=el('div','msg assistant agent-msg');div.append(el('div','head','Knowledge authoring'));
 if(model)div.firstChild.append(el('span','pill',model));
 div.append(el('div','status','starting…'));return div;
}
async function runAuthoring(text,files){
 const model=PROD.session.settings&&(PROD.session.settings.formalizer_model||PROD.session.settings.omp_model)||null;
 const block=agentBlock(model);$('log').append(block);const status=block.querySelector('.status');
 const started=await jcall('POST','/v1/author',{session:PROD.session.id,instructions:text,files,...(model?{model}:{}),wait:false});
 if(!started.ok){status.textContent='Knowledge authoring could not start: '+(started.error?started.error.message:'HTTP '+started.status);block.classList.add('error');return 'failed';}
 const t0=Date.now();let st=null;
 for(;;){
  await new Promise(r=>setTimeout(r,1500));
  const r=await jcall('GET',started.body.status_url);if(!r.ok){status.textContent='The status of the request could not be read: '+errText(r);return 'failed';}
  st=r.body;const secs=Math.round((Date.now()-t0)/1000);
  status.textContent=(st.status==='running'?({queued:'queued',writing:'the model is writing SOP',fixing:'the model is repairing the SOP after validation (round '+st.round+')',validating:'validating the SOP'}[st.phase]||st.phase)+' · '+secs+' s':'finished');
  if(st.status!=='running')break;
 }
 if(!st.result||st.result.status==='failed'){status.textContent='Knowledge authoring failed: '+(st.error||(st.result&&st.result.reason)||'no result');block.classList.add('error');return 'failed';}
 renderAuthoringResult(block,st.result);await refreshSession();return 'done';
}
function renderAuthoringResult(block,res){
 const status=block.querySelector('.status');
 status.textContent=({validated:'Validated',invalid:'Written but not valid after the repair rounds',failed:'The agent failed'}[res.status]||res.status)+' · '+res.rounds+' round'+(res.rounds===1?'':'s')+' · '+(res.duration_ms/1000).toFixed(1)+' s · '+res.usage.turns+' turns · cost '+res.usage.cost_usd.toFixed(4)+' USD ('+res.cost_class+(res.cost_class==='subscription'?', nominal list price':'')+')'+(res.reason?' · '+res.reason:'');
 if((res.circuits||[]).length)block.append(circuitCard(res));
 else block.append(el('p','note','No SOP was produced.'));
 block.append(el('p','note','Validated SOP joins this session only; committing the session to a base memory is a separate step.'));
}
/** Attached files go to knowledge authoring (a model writes circuits for this session); a message without files is a chat turn. */
async function productEarly(text){
 if(!PROD.session||!PROD.files.length)return false;
 const files=PROD.files.splice(0);renderChips();
 const user={id:uid(),role:'user',text,time:Date.now(),attached:files.map(f=>f.name)};remember(user);const userDiv=add(user);
 userDiv.append(el('div','meta','attached: '+files.map(f=>f.name).join(', ')));
 setBusy(true,'Authoring knowledge\u2026');
 input.value='';fit();
 await runAuthoring(text,files);
 return true;
}
// ---- answer feedback (DS022 "Chat feedback"): thumbs up records at once; thumbs down asks for one cause and an optional comment ----
// A function, not a constant: renderLog (earlier in the same script) calls feedbackBar before the constants below are initialised.
function fbIcon(v){return ({up:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v11H4V10h3zm0 0l4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.4 21H7"/></svg>',down:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 14V3h3v11h-3zm0 0l-4 8a2.5 2.5 0 0 1-2.5-2.5V15H5.3a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 6.6 3H17"/></svg>'})[v];}
function saveVote(item,vote){for(const id of conversations){const items=transcript(id);const hit=items.find(x=>x.trace&&x.trace.trace_id===item.trace.trace_id);if(hit){hit.feedback=vote;saveTranscript(id,items);return;}}}
async function sendVote(item,payload){return jcall('POST','/v1/feedback',{session:item.trace.session.id,turn:item.trace.turn,...payload});}
function feedbackBar(item,div){
 const t=item.trace;if(item.role!=='assistant'||!t||!t.session||!t.turn)return;
 const bar=el('div','fb');const note=el('span','fb-note');
 const mk=(vote,label)=>{const b=el('button');b.type='button';b.innerHTML=fbIcon(vote);b.title=label;b.setAttribute('aria-label',label);b.setAttribute('aria-pressed',String(item.feedback===vote));b.dataset.vote=vote;return b;};
 const up=mk('up','Good answer'),down=mk('down','Bad answer');
 const mark=vote=>{item.feedback=vote;up.setAttribute('aria-pressed',String(vote==='up'));down.setAttribute('aria-pressed',String(vote==='down'));saveVote(item,vote);};
 up.onclick=async()=>{const r=await sendVote(item,{vote:'up'});if(r.ok){mark('up');note.textContent='Thanks.';}else note.textContent='Not recorded: '+errText(r);};
 down.onclick=()=>openFeedback(item,r=>{mark('down');note.textContent='Thanks, recorded.';});
 bar.append(up,down,note);div.append(bar);
}
let fbPending=null;
function openFeedback(item,done){
 const d=$('fb-dialog');fbPending={item,done};$('fb-msg').textContent='';$('fb-comment').value='';
 d.querySelectorAll('input[name=fb-cause]').forEach(x=>{x.checked=false;});d.showModal();
}
$('fb-cancel').onclick=()=>{fbPending=null;$('fb-dialog').close();};
$('fb-send').onclick=async()=>{
 if(!fbPending)return;const chosen=$('fb-dialog').querySelector('input[name=fb-cause]:checked');
 if(!chosen){$('fb-msg').textContent='Choose one cause.';return;}
 const comment=$('fb-comment').value.trim();
 const r=await sendVote(fbPending.item,{vote:'down',cause:chosen.value,...(comment?{comment}:{})});
 if(!r.ok){$('fb-msg').textContent='Not recorded: '+errText(r);return;}
 const p=fbPending;fbPending=null;$('fb-dialog').close();p.done(r);
};
loadModels().then(()=>ensureSession()).then(()=>loadStatus());
initTabs();
`;
