/** The Models page (`/models`, DS025, DS027): two tabs.
 *
 * *Models*: the list of MRP-LLM models and an editor for the selected one: name, description, base memory, answer language, whether
 * sessions and requests may override slots; one row per pipeline slot with its strategy (strategies that need components this server
 * does not provide are shown disabled with the reason) and the strategy's parameters; the FAQ of the reflex slot (question, variants,
 * answer); what the model learned (reflex statistics, the learned boundary) and the review queue of the commit strategy review-queue.
 * A new model starts from a profile.
 *
 * *Model gateway*: the Ploinky Workers home of this machine: proxy status and restart, the providers with whether a key is configured
 * (a key is written, never shown), a custom OpenAI-compatible provider, and the tier chains (provider, model from the live catalog,
 * thinking switch). Saving keys or tiers restarts the proxy.
 *
 * Data: /v1/mrp/* and /v1/memories through same-origin fetch with the session cookie; all dynamic text is inserted with textContent. */
import {layout} from './layout.mjs';

const style = `
.mp-wrap{display:grid;grid-template-columns:260px 1fr;gap:16px;padding:16px;align-items:start}
@media(max-width:900px){.mp-wrap{grid-template-columns:1fr}}
.tabs{display:flex;gap:4px;padding:12px 16px 0;border-bottom:1px solid var(--line,#ddd)}
.tabs button{border:0;background:none;padding:10px 14px;font:inherit;cursor:pointer;border-bottom:3px solid transparent}
.tabs button[aria-selected=true]{border-bottom-color:var(--accent,#2b6cb0);font-weight:600}
.mp-list button.model{display:block;width:100%;text-align:left;padding:10px 12px;margin:0 0 6px;border:1px solid var(--line,#ddd);border-radius:8px;background:var(--panel,#fff);cursor:pointer;font:inherit}
.mp-list button.model[aria-current=true]{border-color:var(--accent,#2b6cb0);box-shadow:0 0 0 1px var(--accent,#2b6cb0)}
.mp-list .sub{display:block;color:#666;font-size:.85em}
.card{border:1px solid var(--line,#ddd);border-radius:10px;padding:14px 16px;margin:0 0 14px;background:var(--panel,#fff)}
.card h2{margin:0 0 10px;font-size:1.1em}
.grid2{display:grid;grid-template-columns:180px 1fr;gap:8px 12px;align-items:center}
.grid2 label{font-weight:600}
.mp-list .grid2{grid-template-columns:1fr;gap:4px}.mp-list .grid2 input,.mp-list .grid2 select{width:100%;box-sizing:border-box}.mp-list .grid2 label{margin-top:6px}
input[type=text],input[type=password],input[type=number],select,textarea{font:inherit;padding:6px 8px;border:1px solid #bbb;border-radius:6px;max-width:100%}
textarea{width:100%;min-height:3.2em}
table{border-collapse:collapse;width:100%}
th,td{padding:8px 6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.slot b{display:block}.slot span,.muted{color:#666;font-size:.9em}
.params{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}.params label{font-size:.85em;display:flex;flex-direction:column;gap:2px}
.params input[type=number]{width:90px}
.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 12px;margin-top:6px}.check{display:flex;gap:6px;align-items:center;font-size:.9em;font-weight:400}
.mp-list .checks{grid-template-columns:1fr}
#gateway td:first-child{white-space:nowrap}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ok{color:#1a7f37}.bad{color:#b42318}
.msg{min-height:1.4em}
button.primary{background:var(--accent,#2b6cb0);color:#fff;border:0;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer}
button.small{padding:3px 8px;font-size:.85em}
.faq td textarea{min-height:2.4em}
code.k{font-size:.85em}
`;

const script = `
const $=id=>document.getElementById(id);
const el=(tag,attrs={},...kids)=>{const e=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(k==='text')e.textContent=v;else if(k.startsWith('on'))e[k]=v;else if(v!==false&&v!=null)e.setAttribute(k,v===true?'':v);}for(const c of kids)if(c!=null)e.append(c);return e;};
async function call(method,route,body){const r=await fetch(route,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});const j=await r.json().catch(()=>({}));return {ok:r.ok&&!j.error,status:r.status,body:j};}
const errOf=r=>r.body&&r.body.error?r.body.error.message:'HTTP '+r.status;
const S={catalog:[],models:[],profiles:[],memories:[],tiers:[],tierInfo:[],current:null,draft:null};
// The real provider models behind a Ploinky tier, as the running proxy serves them (GET /v1/mrp/tiers).
function realModels(t){const x=(S.tierInfo||[]).find(y=>y.tier===t);if(!x)return 'not configured in Ploinky Workers';if(x.alias)return 'alias of '+x.alias;if(x.serves)return x.serves+(x.fallback&&x.fallback.length?' (then '+x.fallback.join(', ')+')':'');return (x.chain||[]).map(e=>e.provider+'/'+e.model).join(' then ')+(x.error?' \u2014 '+x.error:'');}
function say(id,text,good){const m=$(id);m.textContent=text||'';m.className='msg '+(good===true?'ok':good===false?'bad':'');}

// ---------------------------------------------------------------- tabs
function tab(name){for(const t of ['models','gateway']){$('tab-'+t).setAttribute('aria-selected',String(t===name));$('panel-'+t).hidden=t!==name;}if(name==='gateway')loadGateway();try{localStorage.setItem('mrp.modelsTab',name)}catch{}}
$('tab-models').onclick=()=>tab('models');$('tab-gateway').onclick=()=>tab('gateway');

// ---------------------------------------------------------------- models
async function loadAll(){
 const [c,m,p,mem,g,ly]=await Promise.all([call('GET','/v1/mrp/strategies?check=1'),call('GET','/v1/mrp/models'),call('GET','/v1/mrp/profiles'),call('GET','/v1/memories'),call('GET','/v1/mrp/tiers'),call('GET','/v1/memory-composer')]);
 if(!c.ok){say('models-msg','Cannot load the strategy catalog: '+errOf(c),false);return;}
 S.catalog=c.body.data;S.models=m.body.data||[];S.profiles=p.body.data||[];S.memories=(mem.body&&mem.body.data)||[];
 S.layers=ly.ok?(ly.body.layers||[]).filter(l=>l.role!=='conversation'&&!/^sm-/.test(l.id)&&l.id!=='conversation-default'):[];
 S.tierInfo=g.ok?g.body.data:[];S.tiers=S.tierInfo.length?S.tierInfo.map(t=>t.tier):['nano','micro','tiny','small','medium','good','best'];
 renderList();const wanted=new URLSearchParams(location.search).get('model');if(!S.current&&S.models.length)select(S.models.some(x=>x.id===wanted)?wanted:S.models[0].id);
}
/** Checkboxes over the knowledge memories, with All and None: {node, value()} */
function picker(selected){
 const checks=S.layers.map(l=>{const c=el('input',{type:'checkbox',value:l.id});c.checked=selected.includes(l.id);return {c,l};});
 const list=el('div',{class:'checks'},...checks.map(({c,l})=>el('label',{class:'check',title:(l.description||l.id).slice(0,300)},c,document.createTextNode(' '+l.name))));
 const bar=el('div',{class:'bar'},el('button',{type:'button',class:'small',text:'All',onclick:()=>checks.forEach(x=>x.c.checked=true)}),el('button',{type:'button',class:'small',text:'None',onclick:()=>checks.forEach(x=>x.c.checked=false)}));
 return {node:el('div',{},bar,list),value:()=>checks.filter(x=>x.c.checked).map(x=>x.l.id)};
}
function renderList(){
 const box=$('model-list');box.textContent='';
 for(const m of S.models)box.append(el('button',{class:'model','aria-current':String(S.current===m.id),onclick:()=>select(m.id)},el('b',{text:m.name}),el('span',{class:'sub',text:m.id+' \\u00b7 '+(m.memories&&m.memories.length?m.memories:[m.base]).join(', ')})));
 const sel=$('new-profile');sel.textContent='';sel.append(el('option',{value:'',text:'(no profile: defaults)'}));for(const p of S.profiles)sel.append(el('option',{value:p.id,text:p.name||p.id}));
 const nb=$('new-memories');nb.textContent='';S.newPicker=picker([]);nb.append(S.newPicker.node);
}
async function select(id){
 S.current=id;renderList();const r=await call('GET','/v1/mrp/models/'+encodeURIComponent(id));
 if(!r.ok){say('models-msg',errOf(r),false);return;}
 S.draft=structuredClone(r.body);renderEditor(r.body.state||{});
}
function strategyOptions(slot,current){
 const sel=el('select',{'aria-label':'strategy of '+slot.title});
 for(const s of slot.strategies){const o=el('option',{value:s.id,text:s.title+(s.default?' (default)':'')+(s.status==='not-implemented'?' \\u2014 not implemented yet':s.available===false?' \\u2014 unavailable':'')});if(s.status==='not-implemented'||(s.available===false&&s.runs==='external'))o.disabled=true;o.title=(s.summary||'')+(s.reason?'\\n'+s.reason:'');sel.append(o);}
 sel.value=current;return sel;
}
function paramInputs(slot,cfg){
 const box=el('div',{class:'params'});const s=slot.strategies.find(x=>x.id===cfg.strategy);if(!s)return box;
 for(const p of s.params){
  const v=cfg.params&&cfg.params[p.key]!==undefined?cfg.params[p.key]:p.default;let input;
  if(p.type==='tier'){input=el('select');for(const t of [...new Set([...S.tiers,v])])input.append(el('option',{value:t,text:t}));input.value=v;const real=el('span',{class:'muted',text:'\u2192 '+realModels(v)});input.onchange=()=>{cfg.params[p.key]=input.value;real.textContent='\u2192 '+realModels(input.value);};box.append(el('label',{title:p.summary||''},el('span',{text:p.key+' (Ploinky tier)'}),input,real));continue;}
  else if(p.type==='enum'){input=el('select');for(const t of p.values)input.append(el('option',{value:t,text:t}));input.value=v;input.onchange=()=>{cfg.params[p.key]=input.value;};}
  else if(p.type==='boolean'){input=el('input',{type:'checkbox'});input.checked=Boolean(v);input.onchange=()=>{cfg.params[p.key]=input.checked;};}
  else {input=el('input',{type:'number',step:'0.01',min:p.min,max:p.max,value:v});input.onchange=()=>{cfg.params[p.key]=Number(input.value);};}
  input.title=p.summary||'';box.append(el('label',{title:p.summary||''},el('span',{text:p.key}),input));
 }
 return box;
}
function renderEditor(state){
 const m=S.draft,box=$('editor');box.textContent='';say('models-msg','');
 m.slots=m.slots||{};
 // general
 const name=el('input',{type:'text',value:m.name,maxlength:120,oninput:e=>m.name=e.target.value});
 const desc=el('textarea',{oninput:e=>m.description=e.target.value});desc.value=m.description||'';
 const knowledge=picker(m.memories&&m.memories.length?m.memories:[m.base]);S.knowledge=knowledge;
 const lang=el('select',{onchange:e=>m.language={output:e.target.value}});for(const [v,t] of [['auto','same as the user\\'s message'],['en','English'],['ro','Romanian'],['fr','French'],['de','German'],['es','Spanish'],['it','Italian'],['pt','Portuguese'],['hu','Hungarian'],['pl','Polish'],['ru','Russian'],['uk','Ukrainian']])lang.append(el('option',{value:v,text:t}));lang.value=(m.language&&m.language.output)||'auto';
 const over=el('input',{type:'checkbox',onchange:e=>m.allowOverrides=e.target.checked});over.checked=Boolean(m.allowOverrides);
 box.append(el('section',{class:'card'},el('h2',{text:'Symbolic Model '+m.id}),el('div',{class:'grid2'},
  el('label',{text:'Name'}),name,el('label',{text:'Description'}),desc,el('label',{text:'Knowledge'}),el('div',{},el('div',{class:'muted',text:'The base memories this Symbolic Model answers from; several are combined into one knowledge base (rebuilt when the choice changes).'}),knowledge.node),el('label',{text:'Answer language'}),lang,
  el('label',{text:'Overrides'}),el('span',{},over,document.createTextNode(' sessions and API requests may change slots and language')))));
 // slots
 const rows=el('tbody');
 for(const slot of S.catalog){
  const cfg=m.slots[slot.id]=m.slots[slot.id]||{strategy:slot.default,params:{}};cfg.strategy=cfg.strategy||slot.default;cfg.params=cfg.params||{};
  const cell=el('td');const sel=strategyOptions(slot,cfg.strategy);
  const info=el('div',{class:'muted'});const paramsBox=el('div');
  const refresh=()=>{const s=slot.strategies.find(x=>x.id===cfg.strategy)||{};info.textContent=(s.summary||'')+(s.cost&&s.cost!=='none'?' Cost: '+s.cost+'.':'')+(s.available===false?' Unavailable here: '+s.reason:'');paramsBox.textContent='';paramsBox.append(paramInputs(slot,cfg));};
  sel.onchange=()=>{cfg.strategy=sel.value;cfg.params={};refresh();};refresh();
  cell.append(sel,info,paramsBox);
  rows.append(el('tr',{},el('td',{class:'slot'},el('b',{text:slot.title}),el('span',{text:slot.summary})),cell));
 }
 box.append(el('section',{class:'card'},el('h2',{text:'Pipeline slots'}),el('p',{class:'muted',text:'One strategy per slot. Hover a strategy for its description; strategies that need components outside this server are listed but cannot be chosen.'}),el('table',{},el('thead',{},el('tr',{},el('th',{text:'Slot'}),el('th',{text:'Strategy and parameters'}))),rows)));
 // FAQ
 const faqBody=el('tbody');
 const drawFaq=()=>{faqBody.textContent='';(m.faq||[]).forEach((f,i)=>{
  const q=el('textarea',{oninput:e=>f.q=e.target.value});q.value=f.q;const vs=el('textarea',{placeholder:'one per line',oninput:e=>f.variants=e.target.value.split('\\n').map(x=>x.trim()).filter(Boolean)});vs.value=(f.variants||[]).join('\\n');
  const a=el('textarea',{oninput:e=>f.a=e.target.value});a.value=f.a;
  faqBody.append(el('tr',{},el('td',{},q),el('td',{},vs),el('td',{},a),el('td',{},el('button',{class:'small',type:'button',text:'Remove',onclick:()=>{m.faq.splice(i,1);drawFaq();}}))));});};
 drawFaq();
 box.append(el('section',{class:'card faq'},el('h2',{text:'FAQ (reflex slot)'}),el('p',{class:'muted',text:'Questions are matched in English after normalization, so one English entry serves every language. Variants are other ways to ask the same thing.'}),
  el('table',{},el('thead',{},el('tr',{},el('th',{text:'Question'}),el('th',{text:'Variants'}),el('th',{text:'Answer'}),el('th',{}))),faqBody),
  el('button',{type:'button',text:'Add a question',onclick:()=>{(m.faq=m.faq||[]).push({q:'',a:''});drawFaq();}})));
 // pattern reflexes
 const refBody=el('tbody');
 const drawRef=()=>{refBody.textContent='';(m.reflexes||[]).forEach((r,i)=>{
  const p=el('input',{type:'text',placeholder:'^who are you',oninput:e=>r.pattern=e.target.value||undefined});p.value=r.pattern||'';
  const af=el('select',{onchange:e=>{r.affect=e.target.value||undefined;}},el('option',{value:'',text:'any'}),...['frustrated','urgent','confused','grateful','angry','happy','sad'].map(v=>el('option',{value:v,text:v})));af.value=r.affect||'';
  const mode=el('select',{onchange:e=>{r.mode=e.target.value;}},...['stop','continue','pragmatic'].map(v=>el('option',{value:v,text:v})));mode.value=r.mode||'stop';
  const text=el('textarea',{placeholder:'reply (stop, continue) or tone line (pragmatic)',oninput:e=>{if((r.mode||'stop')==='pragmatic')r.tone=e.target.value;else r.reply=e.target.value;}});text.value=(r.mode==='pragmatic'?r.tone:r.reply)||'';
  const pr=el('input',{type:'number',step:'1',style:'width:5em',oninput:e=>r.priority=Number(e.target.value)||0});pr.value=r.priority||0;
  refBody.append(el('tr',{},el('td',{},p),el('td',{},af),el('td',{},mode),el('td',{},text),el('td',{},pr),el('td',{},el('button',{class:'small',type:'button',text:'Remove',onclick:()=>{m.reflexes.splice(i,1);drawRef();}}))));});};
 drawRef();
 box.append(el('section',{class:'card faq'},el('h2',{text:'Pattern reflexes (reflex slot)'}),el('p',{class:'muted',text:'Case-insensitive regular expressions over the English message and/or an affect label of the turn, tried by priority before the FAQ (every reflex strategy but off); reflex wires of the base memory count too. stop answers and ends the turn, continue puts the reply before the computed answer, pragmatic only gives the voice a tone line.'}),
  el('table',{},el('thead',{},el('tr',{},el('th',{text:'Pattern'}),el('th',{text:'Affect'}),el('th',{text:'Mode'}),el('th',{text:'Reply or tone'}),el('th',{text:'Priority'}),el('th',{}))),refBody),
  el('button',{type:'button',text:'Add a reflex',onclick:()=>{(m.reflexes=m.reflexes||[]).push({pattern:'',mode:'stop',reply:''});drawRef();}})));
 // learned state and review queue
 const r=state.reflex||{};
 const learned=el('p',{text:'Reflex answers: '+(r.hits||0)+' \\u00b7 votes up '+(r.up||0)+', down '+(r.down||0)+(typeof r.learnedThreshold==='number'?' \\u00b7 learned boundary '+r.learnedThreshold:'')});
 const queue=el('div');const items=(state.review||[]).filter(x=>x.status==='pending');
 if(!items.length)queue.append(el('p',{class:'muted',text:'No knowledge waiting for review.'}));
 for(const it of items){const pre=el('pre',{text:it.circuits.map(c=>c.text).join('\\n\\n')});
  queue.append(el('div',{class:'card'},el('p',{text:(it.source?'From '+it.source:'From session '+it.session)+(it.message?': \\u201c'+it.message+'\\u201d':'')}),pre,el('div',{class:'bar'},
   el('button',{class:'primary',type:'button',text:'Approve: write to the base memory',onclick:async()=>{const x=await call('POST','/v1/mrp/models/'+m.id+'/review/'+it.id+'/approve');say('models-msg',x.ok?'Written to '+m.base+'.':errOf(x),x.ok);select(m.id);}}),
   el('button',{type:'button',text:'Reject',onclick:async()=>{const x=await call('POST','/v1/mrp/models/'+m.id+'/review/'+it.id+'/reject');say('models-msg',x.ok?'Rejected.':errOf(x),x.ok);select(m.id);}}))));}
 box.append(el('section',{class:'card'},el('h2',{text:'What the model learned'}),learned,el('h3',{text:'Review queue'}),queue));
 // actions
 box.append(el('div',{class:'bar'},el('button',{class:'primary',type:'button',text:'Save model',onclick:save}),el('a',{href:'/chat',text:'Open the chat'}),el('span',{style:'flex:1'}),el('button',{type:'button',text:'Delete model',onclick:del})));
}
async function save(){
 const m=S.draft;const mem=S.knowledge?S.knowledge.value():[m.base];if(!mem.length){say('models-msg','Choose at least one base memory.',false);return;}
 const body={name:m.name,description:m.description||'',memories:mem,language:m.language,allowOverrides:Boolean(m.allowOverrides),slots:m.slots,faq:(m.faq||[]).filter(f=>f.q&&f.a),reflexes:(m.reflexes||[]).filter(r=>(r.pattern||r.affect)&&(r.mode==='pragmatic'?r.tone:r.reply)).map(r=>({...r,mode:r.mode||'stop'}))};
 const r=await call('PUT','/v1/mrp/models/'+encodeURIComponent(m.id),body);
 if(r.ok){const l=await call('GET','/v1/mrp/models');S.models=l.body.data;await select(m.id);}
 say('models-msg',r.ok?'Saved. New turns use these settings.':errOf(r),r.ok);
}
async function del(){if(!confirm('Delete the model '+S.draft.id+'? Its base memory stays.'))return;const r=await call('DELETE','/v1/mrp/models/'+encodeURIComponent(S.draft.id));if(r.ok){S.current=null;$('editor').textContent='';await loadAll();}say('models-msg',r.ok?'Deleted.':errOf(r),r.ok);}
$('new-go').onclick=async()=>{
 const body={id:$('new-id').value.trim(),...($('new-name').value.trim()?{name:$('new-name').value.trim()}:{}),...($('new-profile').value?{profile:$('new-profile').value}:{}),...($('new-createbase').value.trim()?{base:$('new-createbase').value.trim(),createBase:true}:{memories:S.newPicker?S.newPicker.value():[]})};
 if(!body.createBase&&!body.memories.length){say('new-msg','Choose at least one base memory, or name a new empty one.',false);return;}
 const r=await call('POST','/v1/mrp/models',body);say('new-msg',r.ok?'Created.':errOf(r),r.ok);if(r.ok){await loadAll();select(r.body.id);}
};

// ---------------------------------------------------------------- model gateway (Ploinky Workers)
async function loadGateway(){
 const r=await call('GET','/v1/mrp/pworker');const box=$('gateway');box.textContent='';
 if(!r.ok){box.append(el('p',{class:'bad',text:errOf(r)}));return;}
 const g=r.body;S.tiers=Object.keys(g.tiers||{});
 const served=Object.fromEntries((g.served||[]).map(t=>[t.id,t.x_tier]));
 box.append(el('section',{class:'card'},el('h2',{text:'Proxy'}),el('div',{class:'bar'},el('span',{class:g.proxy.running?'ok':'bad',text:g.proxy.running?'running (pid '+g.proxy.pid+')':'not running'}),
  el('button',{type:'button',text:g.proxy.running?'Restart':'Start',onclick:async()=>{say('gw-msg','Restarting\\u2026');const x=await call('POST','/v1/mrp/pworker/restart');say('gw-msg',x.ok?'The proxy runs with the saved keys and tiers.':errOf(x),x.ok);loadGateway();}})),
  el('p',{class:'muted',text:'Every model call goes through this Ploinky Workers proxy, by tier name. Keys are stored in the Pworker home of this machine (keys/<provider>.env, mode 0600) and are never shown again.'})));
 // providers
 const prow=el('tbody');
 for(const p of g.providers){
  const key=el('input',{type:'password',placeholder:p.local?'local model: no key':p.noKey?'no key needed':'paste an API key',autocomplete:'off'});key.disabled=p.local||p.noKey;
  const status=el('span',{class:p.keyConfigured||p.noKey||p.local?'ok':'muted',text:p.local?'local (started on demand)':p.noKey?'no key needed':p.keyConfigured?'key configured':'no key'});
  const saveKey=el('button',{type:'button',class:'small',text:'Save key',onclick:async()=>{say('gw-msg','Checking the key with '+p.name+'\\u2026');const x=await call('PUT','/v1/mrp/pworker/providers/'+p.name+'/key',{key:key.value.trim()});if(x.ok){key.value='';const y=await call('POST','/v1/mrp/pworker/restart');say('gw-msg','Key saved for '+p.name+(x.body.models!=null?' ('+x.body.models+' models in its catalog)':'')+'; proxy restarted.',y.ok);loadGateway();}else say('gw-msg',errOf(x),false);}});
  const drop=el('button',{type:'button',class:'small',text:'Remove key',onclick:async()=>{if(!confirm('Remove the API key of '+p.name+'?'))return;const x=await call('PUT','/v1/mrp/pworker/providers/'+p.name+'/key',{key:''});if(x.ok)await call('POST','/v1/mrp/pworker/restart');say('gw-msg',x.ok?'Key removed.':errOf(x),x.ok);loadGateway();}});
  saveKey.disabled=drop.disabled=p.local||p.noKey;
  prow.append(el('tr',{},el('td',{},el('b',{text:p.name}),el('div',{class:'muted',text:p.baseUrl})),el('td',{},status),el('td',{},el('div',{class:'bar'},key,saveKey,p.keyConfigured?drop:null))));
 }
 const cname=el('input',{type:'text',placeholder:'name, e.g. myapi'}),cend=el('input',{type:'text',placeholder:'https://host/v1'}),ckey=el('input',{type:'password',placeholder:'key (optional)'}),crpm=el('input',{type:'number',value:60,min:1});
 box.append(el('section',{class:'card'},el('h2',{text:'Providers and API keys'}),el('table',{},el('thead',{},el('tr',{},el('th',{text:'Provider'}),el('th',{text:'State'}),el('th',{text:'API key'}))),prow),
  el('h3',{text:'Add an OpenAI-compatible provider'}),el('div',{class:'bar'},cname,cend,ckey,el('label',{},document.createTextNode('requests/min '),crpm),
   el('button',{type:'button',text:'Add',onclick:async()=>{const x=await call('POST','/v1/mrp/pworker/providers',{name:cname.value.trim(),endpoint:cend.value.trim(),key:ckey.value.trim(),rpm:Number(crpm.value)});if(x.ok)await call('POST','/v1/mrp/pworker/restart');say('gw-msg',x.ok?'Provider added; proxy restarted.':errOf(x),x.ok);if(x.ok)loadGateway();}}))));
 // tiers
 const trow=el('tbody');
 for(const [tier,chain] of Object.entries(g.tiers||{})){
  const now=served[tier];const entries=Array.isArray(chain)?chain:[];
  const desc=typeof chain==='string'?'alias of '+chain:entries.map((e,i)=>(i?'then ':'')+e.upstream+'/'+e.model+(e.extraBody&&e.extraBody.thinking&&e.extraBody.thinking.type==='disabled'?' (thinking off)':'')+(e.extraBody&&e.extraBody.reasoning_effort?' (reasoning '+e.extraBody.reasoning_effort+')':'')+(e.minTokens?' (min '+e.minTokens+' tokens)':'')).join(', ');
  trow.append(el('tr',{},el('td',{},el('b',{text:tier})),el('td',{text:desc}),el('td',{class:now&&!now.error?'ok':'bad',text:now?(now.error||'serves '+now.serves):'proxy not running'}),el('td',{},el('button',{type:'button',class:'small',text:'Edit',onclick:()=>editTier(tier,entries,g.providers)}))));
 }
 box.append(el('section',{class:'card'},el('h2',{text:'Tiers'}),el('p',{class:'muted',text:'A strategy names a tier (tiny, small, fast\\u2026); the tier is an ordered chain of provider/model: the first usable entry serves, the rest are fallbacks. Reasoning models spend tokens before answering: choose thinking off where the provider allows it (DeepSeek), or a low reasoning effort with a minimum token budget for models that always reason (z.ai glm-5.3-flash).'}),
  el('table',{},el('thead',{},el('tr',{},el('th',{text:'Tier'}),el('th',{text:'Chain'}),el('th',{text:'Now'}),el('th',{}))),trow),el('div',{id:'tier-editor'}),
  el('div',{class:'bar'},el('button',{type:'button',text:'New tier',onclick:()=>{const n=prompt('Name of the new tier (letters, digits, - and _):');if(n)editTier(n.trim(),[],g.providers);}}))));
}
function editTier(tier,entries,providers){
 const box=$('tier-editor');box.textContent='';const rows=entries.length?entries.map(e=>({...e})):[{upstream:'',model:''}];
 const list=el('div');
 const draw=()=>{list.textContent='';rows.forEach((r,i)=>{
  const prov=el('select');prov.append(el('option',{value:'',text:'provider\\u2026'}));for(const p of providers)prov.append(el('option',{value:p.name,text:p.name+(p.keyConfigured||p.noKey||p.local?'':' (no key)')}));prov.value=r.upstream||'';
  const model=el('input',{type:'text',value:r.model||'',placeholder:'model id',list:'models-'+i});const dl=el('datalist',{id:'models-'+i});
  const loadModels=async()=>{dl.textContent='';if(!prov.value)return;const x=await call('GET','/v1/mrp/pworker/providers/'+prov.value+'/models');if(x.ok)for(const mm of x.body.data)dl.append(el('option',{value:mm.id}));};
  prov.onchange=()=>{r.upstream=prov.value;loadModels();};model.oninput=()=>{r.model=model.value.trim();};loadModels();
  // Reasoning: the provider default, thinking off (DeepSeek, most GLM servers), or a low reasoning effort (models that always reason, such as z.ai glm-5.3-flash).
  const reason=el('select',{title:'How this model reasons before answering. Models that always reason (z.ai glm-5.3-flash) refuse "off": use "low effort" with a minimum token budget.'});
  for(const [v,t] of [['','provider default'],['off','thinking off'],['low','low reasoning effort']])reason.append(el('option',{value:v,text:t}));
  const eb=r.extraBody||{};reason.value=eb.reasoning_effort==='low'?'low':(eb.thinking&&eb.thinking.type==='disabled')?'off':'';
  reason.onchange=()=>{const x={...(r.extraBody||{})};delete x.thinking;delete x.reasoning_effort;if(reason.value==='off')x.thinking={type:'disabled'};if(reason.value==='low')x.reasoning_effort='low';r.extraBody=x;if(!Object.keys(x).length)delete r.extraBody;};
  const minTok=el('input',{type:'number',min:1,step:1,value:r.minTokens??'',placeholder:'min tokens',title:'Raises a smaller max_tokens of a request (needed by models that reason before answering, for example 512).',style:'width:110px'});
  minTok.onchange=()=>{const n=Number(minTok.value);if(Number.isSafeInteger(n)&&n>0)r.minTokens=n;else delete r.minTokens;};
  list.append(el('div',{class:'bar'},el('span',{text:(i?'fallback '+i:'primary')}),prov,model,dl,reason,minTok,el('button',{type:'button',class:'small',text:'Remove',onclick:()=>{rows.splice(i,1);draw();}})));});};
 draw();
 box.append(el('div',{class:'card'},el('h3',{text:'Tier '+tier}),list,el('div',{class:'bar'},
  el('button',{type:'button',text:'Add a fallback',onclick:()=>{rows.push({upstream:'',model:''});draw();}}),
  el('button',{class:'primary',type:'button',text:'Save tier',onclick:async()=>{const entries=rows.filter(r=>r.upstream&&r.model).map(r=>({provider:r.upstream,model:r.model,...(r.extraBody?{extraBody:r.extraBody}:{}),...(r.minTokens?{minTokens:r.minTokens}:{})}));const x=await call('PUT','/v1/mrp/pworker/tiers/'+encodeURIComponent(tier),{entries});if(x.ok)await call('POST','/v1/mrp/pworker/restart');say('gw-msg',x.ok?'Tier '+tier+' saved; proxy restarted.':errOf(x),x.ok);if(x.ok)loadGateway();}}),
  el('button',{type:'button',text:'Cancel',onclick:()=>{box.textContent='';}}))));
}

loadAll();
let first='models';try{first=localStorage.getItem('mrp.modelsTab')||'models'}catch{}
if(location.hash==='#gateway')first='gateway';if(new URLSearchParams(location.search).get('model'))first='models';
tab(first);
`;

export function modelsPage({signedIn = true} = {}) {
  const body = `<main>
<nav class="tabs" role="tablist" aria-label="Models page"><button id="tab-models" role="tab" type="button">Symbolic Models</button><button id="tab-gateway" role="tab" type="button">Model gateway (Ploinky Workers)</button></nav>
<div id="panel-models" role="tabpanel"><div class="mp-wrap">
<aside class="mp-list"><div id="model-list"></div>
<section class="card"><h2>New model</h2><div class="grid2"><label for="new-id">Id</label><input id="new-id" type="text" maxlength="64" placeholder="lowercase, e.g. hr-policies">
<label for="new-name">Name</label><input id="new-name" type="text" maxlength="120"><label for="new-profile">Profile</label><select id="new-profile"></select>
<label>Knowledge</label><div id="new-memories"></div>
<label for="new-createbase">Or a new empty memory</label><span><input id="new-createbase" type="text" maxlength="64" placeholder="id of a new empty memory (optional)"></span></div><p><button class="primary" id="new-go" type="button">Create</button></p><p id="new-msg" class="msg" role="status"></p></section></aside>
<div><p class="muted">A <b>Symbolic Model</b> is what this server exposes (the <code>model</code> of the API and the chat): a base memory plus one strategy per pipeline slot. Strategies that call a language model name a <b>Ploinky tier</b> (tiny, small, fast…); the arrow after each tier shows the real provider model Ploinky Workers uses for it.</p><p id="models-msg" class="msg" role="status"></p><div id="editor"><p class="muted">Loading…</p></div></div>
</div></div>
<div id="panel-gateway" role="tabpanel" hidden><div style="padding:16px"><p id="gw-msg" class="msg" role="status"></p><div id="gateway"><p class="muted">Loading…</p></div></div></div>
</main>`;
  return layout({title: 'Symbolic Models · MRP-LLM', active: 'models', signedIn, body, script, style});
}
