/** The *Symbolic Models* tab of the chat (DS025 "Symbolic Model and tier", DS027).
 *
 * A Symbolic Model is what MRP-LLM exposes and what the chat talks to: a base memory plus one strategy per pipeline slot. The language
 * models it uses are named by **tiers** (tiny, small, fast, …), and Ploinky Workers maps every tier to real provider models. The tab
 * lists the Symbolic Models (use one in the chat, configure it), shows for the selected one every slot that calls a language model
 * with its tier and the real model behind it, lets the user change those tiers and create a new Symbolic Model from a profile, and shows
 * the whole tier table of Ploinky Workers (read only here; keys and chains are edited on /models → Model gateway).
 *
 * Data: GET /v1/mrp/models, /v1/mrp/strategies, /v1/mrp/tiers, /v1/mrp/profiles, /v1/memories; PUT /v1/mrp/models/{id};
 * POST /v1/mrp/models. All dynamic text is inserted with textContent. The script runs after the product script (`PROD`, `store`,
 * `startSession`, `jcall`, `el`, `chosenModel`, `loadModels`).
 */
export const SYMBOLIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/></svg>';

export const SYMBOLIC_STYLE = `
#panel-symbolic td .sub{display:block;color:var(--muted);font-size:12px;font-weight:400}
#panel-symbolic .what .sub{display:block;color:var(--muted);font-size:12px;margin-top:2px}
#panel-symbolic ul.plain{list-style:none;margin:0;padding:0;font-size:13px}#panel-symbolic ul.plain li{margin:2px 0}
#panel-symbolic td.actions{white-space:nowrap}#panel-symbolic td.actions>*{margin-right:6px}
#panel-symbolic .card{margin-top:16px}
#panel-symbolic td.name{white-space:nowrap}
#panel-symbolic .sym-knowledge{align-items:flex-start}#panel-symbolic .sym-knowledge .ctl{flex:1 1 60%;max-width:none}
#panel-symbolic .sym-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 12px;margin-top:6px}
#panel-symbolic .sym-check{display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer}
#panel-symbolic .sym-pickbar{display:flex;gap:6px}
`;

export const symbolicTabHtml = `<h2>Symbolic Models</h2>
<p class="lead">A <b>Symbolic Model</b> is what this server exposes and what you talk to in the chat (the <code>model</code> of the API): a base memory plus one strategy for every step of the pipeline. Its steps that need a language model name a <b>tier</b> of Ploinky Workers (tiny, small, fast…); Ploinky Workers maps each tier to real provider models. Below: the Symbolic Models, the tiers each one uses with the real models behind them, and the tier table of Ploinky Workers.</p>
<div id="sym-msg" class="msgline" role="status"></div>
<table class="mem" aria-label="Symbolic Models"><thead><tr><th>Symbolic Model</th><th>Knowledge</th><th>Language models used</th><th>Actions</th></tr></thead><tbody id="sym-rows"><tr><td colspan="4">Loading…</td></tr></tbody></table>
<section class="card set" id="sym-config" hidden></section>
<section class="card set"><h3>New Symbolic Model</h3><p class="help">Starts from a profile (a ready-made set of strategies); every setting can be changed afterwards here or on the Symbolic Models page.</p>
<div class="srow"><div class="what"><b><label class="plain" for="sym-new-id">Id</label></b><span>Lowercase letters, digits, - and _; the <code>model</code> name in the API.</span></div><div class="ctl"><input id="sym-new-id" type="text" maxlength="64" placeholder="e.g. hr-policies"></div></div>
<div class="srow"><div class="what"><b><label class="plain" for="sym-new-name">Name</label></b></div><div class="ctl"><input id="sym-new-name" type="text" maxlength="120"></div></div>
<div class="srow"><div class="what"><b><label class="plain" for="sym-new-profile">Profile</label></b></div><div class="ctl"><select id="sym-new-profile"></select></div></div>
<div class="srow sym-knowledge"><div class="what"><b>Knowledge</b><span>The base memories the model answers from; several are combined into one knowledge base for the model.</span></div><div class="ctl" id="sym-new-memories"></div></div>
<div class="srow"><div class="what"></div><div class="ctl"><button id="sym-new-go" class="primary" type="button">Create</button></div></div></section>
<section class="card set"><h3>Ploinky Workers tiers</h3><p class="help">The real models behind every tier, as the running Ploinky proxy serves them: the first usable entry answers, the others are fallbacks. Keys and chains are edited by the administrator on <a href="/models#gateway">Symbolic Models → Model gateway</a>.</p>
<table class="mem" aria-label="Ploinky Workers tiers"><thead><tr><th>Tier</th><th>Serves now</th><th>Configured chain</th></tr></thead><tbody id="sym-tiers"><tr><td colspan="3">Loading…</td></tr></tbody></table></section>`;

export const symbolicScript = `
// ---- Symbolic Models tab
const SYM={models:[],catalog:[],tiers:[],profiles:[],layers:[],open:null,draft:null};
// The base memories a Symbolic Model can use as knowledge: every knowledge memory except the composed ones of other models and the
// chat's conversation layers.
const knowledgeLayers=()=>SYM.layers.filter(l=>l.role!=='conversation'&&!/^sm-/.test(l.id)&&l.id!=='conversation-default');
const memName=id=>(SYM.layers.find(l=>l.id===id)||{name:id}).name;
const memoriesOf=m=>m.memories&&m.memories.length?m.memories:[m.base];
/** Checkboxes over the knowledge memories, with All and None: {node, value()} */
function memoryPicker(selected){
 const box=el('div','sym-picker');const list=el('div','sym-checks');const checks=[];
 for(const l of knowledgeLayers()){const lab=document.createElement('label');lab.className='sym-check';const c=document.createElement('input');c.type='checkbox';c.value=l.id;c.checked=selected.includes(l.id);checks.push(c);
  lab.append(c,document.createTextNode(' '+l.name));lab.title=(l.description||l.id).slice(0,300);list.append(lab);}
 const all=el('button','small','All');all.type='button';all.onclick=()=>checks.forEach(c=>c.checked=true);
 const none=el('button','small','None');none.type='button';none.onclick=()=>checks.forEach(c=>c.checked=false);
 const bar=el('div','sym-pickbar');bar.append(all,none);box.append(bar,list);
 return {node:box,value:()=>checks.filter(c=>c.checked).map(c=>c.value)};
}
let newPicker=null;
const tierOf=t=>SYM.tiers.find(x=>x.tier===t);
function realModels(t){const x=tierOf(t);if(!x)return 'tier '+t+' is not configured in Ploinky Workers';if(x.alias)return 'alias of '+x.alias+': '+realModels(x.alias);if(x.serves)return x.serves+(x.fallback&&x.fallback.length?' (then '+x.fallback.join(', ')+')':'');if(x.error&&x.chain.length===0)return x.error;return x.chain.map(e=>e.provider+'/'+e.model).join(' then ')+(x.error?' \\u2014 '+x.error:'');}
// The slots of a model whose current strategy names a tier: [{slot, title, strategy, tier}].
function tierSlots(m){
 const out=[];for(const sl of SYM.catalog){const cfg=(m.slots||{})[sl.id]||{strategy:sl.default,params:{}};const st=sl.strategies.find(s=>s.id===(cfg.strategy||sl.default));if(!st)continue;
  const p=st.params.find(x=>x.type==='tier');if(!p)continue;out.push({slot:sl.id,title:sl.title,strategy:st.title,tier:(cfg.params&&cfg.params.tier)||p.default});}
 return out;
}
async function loadSymbolic(){
 const [m,c,t,p,ly]=await Promise.all([jcall('GET','/v1/mrp/models'),jcall('GET','/v1/mrp/strategies'),jcall('GET','/v1/mrp/tiers'),jcall('GET','/v1/mrp/profiles'),jcall('GET','/v1/memory-composer')]);
 if(!m.ok||!c.ok){setMsg('sym-msg','Cannot load the Symbolic Models: '+errText(m.ok?c:m),'bad');return;}
 SYM.models=m.body.data;SYM.catalog=c.body.data;SYM.tiers=t.ok?t.body.data:[];SYM.profiles=p.ok?p.body.data:[];SYM.layers=ly.ok?ly.body.layers||[]:[];
 renderSymbolic();renderTiers();
 const prof=$('sym-new-profile');prof.textContent='';prof.append(el('option','', '(defaults)'));prof.lastChild.value='';for(const x of SYM.profiles){const o=el('option','',x.name||x.id);o.value=x.id;prof.append(o);}
 newPicker=memoryPicker([]);const nm=$('sym-new-memories');nm.textContent='';nm.append(newPicker.node);
}
function renderSymbolic(){
 const rows=$('sym-rows');rows.textContent='';
 if(!SYM.models.length){const tr=el('tr');const td=el('td','','No Symbolic Model yet: create one below.');td.colSpan=4;tr.append(td);rows.append(tr);return;}
 for(const m of SYM.models){
  const tr=el('tr');const name=el('td','name');name.append(el('div','',m.name));name.append(el('div','sub',m.id+(m.id===chosenModel()?' \\u00b7 in use in this chat':'')));
  const uses=el('td');const ul=el('ul','plain');for(const s of tierSlots(m)){ul.append(el('li','',s.title+': '+s.tier+' \\u2192 '+realModels(s.tier)));}uses.append(ul);
  const act=el('td','actions');
  const use=el('button','', m.id===chosenModel()?'In use':'Use in chat');use.type='button';use.disabled=m.id===chosenModel();
  use.onclick=async()=>{store.set('mrp.model',m.id);if($('mrp-model'))$('mrp-model').value=m.id;PROD.session=null;await startSession(null);renderSymbolic();switchTab('chat');};
  const conf=el('button','', 'Configure tiers');conf.type='button';conf.onclick=()=>openConfig(m.id);
  const all=el('a','', 'All settings');all.href='/models?model='+encodeURIComponent(m.id);
  act.append(use,conf,all);
  tr.append(name,el('td','',memoriesOf(m).map(memName).join(', ')),uses,act);rows.append(tr);
 }
}
function openConfig(id){
 const m=SYM.models.find(x=>x.id===id);if(!m)return;SYM.open=id;SYM.draft=structuredClone(m);
 const box=$('sym-config');box.hidden=false;box.textContent='';
 box.append(el('h3','', 'Configure '+m.name));
 box.append(el('p','help','Every step of '+m.name+' that calls a language model names a tier; choose the tier and see the real model Ploinky Workers uses for it. The strategies themselves are chosen on the Symbolic Models page.'));
 const slots=tierSlots(SYM.draft);
 if(!slots.length)box.append(el('p','help','No step of this model calls a language model.'));
 for(const s of slots){
  const sel=document.createElement('select');sel.setAttribute('aria-label','tier of '+s.title);
  const names=[...new Set([...SYM.tiers.map(t=>t.tier),s.tier])];for(const n of names){const o=el('option','',n);o.value=n;sel.append(o);}sel.value=s.tier;
  const real=el('span','sub',realModels(s.tier));
  sel.onchange=()=>{const cfg=SYM.draft.slots[s.slot]=SYM.draft.slots[s.slot]||{strategy:SYM.catalog.find(c=>c.id===s.slot).default,params:{}};cfg.params={...(cfg.params||{}),tier:sel.value};real.textContent=realModels(sel.value);};
  const what=el('div','what');what.append(el('b','',s.title));what.append(el('span','',s.strategy));what.append(real);
  const ctl=el('div','ctl');ctl.append(sel);const row=el('div','srow');row.append(what,ctl);box.append(row);
 }
 const picker=memoryPicker(memoriesOf(m));
 const kw=el('div','what');kw.append(el('b','','Knowledge'));kw.append(el('span','','The base memories '+m.name+' answers from. Several are combined into one knowledge base (rebuilt when the choice changes); memories with conflicting definitions are refused with the reason.'));
 const kc=el('div','ctl');kc.append(picker.node);const krow=el('div','srow sym-knowledge');krow.append(kw,kc);box.insertBefore(krow,box.children[2]||null);
 const save=el('button','primary','Save');save.type='button';
 save.onclick=async()=>{const mem=picker.value();if(!mem.length){setMsg('sym-msg','Choose at least one base memory.','bad');return;}setMsg('sym-msg','Saving'+(mem.length>1?' (combining '+mem.length+' memories)':'')+'\u2026');const r=await jcall('PUT','/v1/mrp/models/'+encodeURIComponent(id),{slots:SYM.draft.slots,memories:mem});setMsg('sym-msg',r.ok?'Saved: new sessions of '+m.name+' use this knowledge and these tiers.':errText(r),r.ok?'ok':'bad');if(r.ok){await loadSymbolic();openConfig(id);}};
 const close=el('button','', 'Close');close.type='button';close.onclick=()=>{box.hidden=true;SYM.open=null;};
 const bar=el('div','srow');const w=el('div','what');const c=el('div','ctl');c.append(save,close);bar.append(w,c);box.append(bar);
 box.scrollIntoView({block:'nearest'});
}
function renderTiers(){
 const rows=$('sym-tiers');rows.textContent='';
 if(!SYM.tiers.length){const tr=el('tr');const td=el('td','','No tier information (the Ploinky configuration could not be read).');td.colSpan=3;tr.append(td);rows.append(tr);return;}
 for(const t of SYM.tiers){
  const tr=el('tr');tr.append(el('td','name',t.tier));
  tr.append(el('td','',t.alias?'alias of '+t.alias:t.serves?t.serves+(t.fallback.length?' (then '+t.fallback.join(', ')+')':''):(t.error||'\\u2014')));
  tr.append(el('td','',t.alias?'':t.chain.map(e=>e.provider+'/'+e.model+(e.thinking==='off'?' (thinking off)':'')+(e.reasoning_effort?' (reasoning '+e.reasoning_effort+')':'')+(e.minTokens?' (min '+e.minTokens+' tokens)':'')).join(' \\u2192 ')));
  rows.append(tr);
 }
}
$('sym-new-go').onclick=async()=>{
 const mem=newPicker?newPicker.value():[];if(!mem.length){setMsg('sym-msg','Choose at least one base memory as the knowledge of the new model.','bad');return;}
 const body={id:$('sym-new-id').value.trim(),...($('sym-new-name').value.trim()?{name:$('sym-new-name').value.trim()}:{}),...($('sym-new-profile').value?{profile:$('sym-new-profile').value}:{}),memories:mem};
 const r=await jcall('POST','/v1/mrp/models',body);setMsg('sym-msg',r.ok?'Created the Symbolic Model '+r.body.name+'.':errText(r),r.ok?'ok':'bad');
 if(r.ok){$('sym-new-id').value='';$('sym-new-name').value='';await loadModels();await loadSymbolic();openConfig(r.body.id);}
};
`;
