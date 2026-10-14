/** The knowledge browser page `/review` (DS022 "Knowledge browser"). Read only: what a base memory or a chat session knows, layer by
 * layer, with provenance and evidence, risk-sorted views that put likely problems first (flags), keyword search, and cards for
 * entities, predicates and rules with generated sentences, example derivations and the oracle's derive. There is no accept or
 * reject control (AGENTS.md direction 8). The state is in the URL, so the chat trace can link to a card:
 *   /review?memory=world-v1&entity=albert_einstein   /review?session=<id>&predicate=works_at   /review?memory=core-en&view=memory
 * The page reads `/v1/knowledge/*` (server/review.mjs). */
import {layout} from './layout.mjs';

const style = `
.wrap{max-width:1180px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}
.bar input[type=search]{flex:1 1 260px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--line);background:var(--soft);font-size:12px;margin:1px 3px 1px 0;white-space:nowrap}
.pill.warn{border-color:#c98a00}.pill.bad{border-color:var(--bad)}.pill.ok{border-color:var(--ok)}
.pill.on{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}
button.pill{cursor:pointer;font:inherit;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
td.num,th.num{text-align:right}
.item{border-top:1px solid var(--line);padding:8px 0}.item:first-child{border-top:0}
.item h3{font-size:15px;margin:0 0 4px}.risk{font-weight:700;color:var(--bad)}
.ex{margin:4px 0 0 0;padding:0;list-style:none}.ex li{margin:2px 0}.ex .arrow{color:var(--muted)}
.say{font-style:italic}code.atom{font-size:12.5px}
.flags li{color:var(--bad);font-size:13.5px}.ev{color:var(--muted);font-size:13px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:820px){.cols{grid-template-columns:1fr}}
.group h2{font-size:1.05rem;margin:8px 0}.muted small{font-size:12px}
details.more summary{cursor:pointer;color:var(--accent)}
.proof{margin:4px 0 6px 14px;border-left:2px solid var(--line);padding-left:8px;font-size:13.5px}
`;

const script = `
const $=id=>document.getElementById(id);
const h=(tag,attrs={},...kids)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs||{})){if(v==null||v===false)continue;if(k==='class')e.className=v;else if(k==='text')e.textContent=v;else if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v);}for(const k of kids.flat()){if(k==null||k===false)continue;e.append(k instanceof Node?k:document.createTextNode(String(k)));}return e;};
const get=async(path)=>{const r=await fetch(path,{credentials:'same-origin',headers:{Accept:'application/json'}});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error?.message||('HTTP '+r.status));return body;};
const FLAG_TEXT={no_description:'predicate without a description',form_no_evidence:'form with no corpus or Wikidata evidence',shared_form:'form claimed by another predicate',undeclared:'facts or lexeme of an undeclared predicate or class',rule:'rule or default (derives new facts)',converse_frame:'converse frame (object first)',flipped_mapping:'Wikidata property emitted flipped',merged_mapping:'several properties under one predicate',review_dropped:'the build dropped forms of this predicate',no_lexeme:'no English form reaches it',partial_rule:'rule with comparisons, negations or exceptions',class:'class entity',curated_values:'curated list of values'};
let state=Object.fromEntries(new URLSearchParams(location.search));
const targetParams=()=>state.session?{session:state.session}:{memory:state.memory||''};
const qs=o=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!==undefined&&v!==null&&v!=='')).toString();
const href=o=>'/review?'+qs({...targetParams(),...o});
function go(o,replace){state={...targetParams(),...o};const url='/review?'+qs(state);history[replace?'replaceState':'pushState'](null,'',url);render();}
window.addEventListener('popstate',()=>{state=Object.fromEntries(new URLSearchParams(location.search));render();});
document.addEventListener('click',e=>{const a=e.target.closest('a[data-nav]');if(!a||e.ctrlKey||e.metaKey||e.button!==0)return;e.preventDefault();state=Object.fromEntries(new URL(a.href).searchParams);history.pushState(null,'',a.href);render();});
const link=(text,o)=>h('a',{href:href(o),'data-nav':'1'},text);
const entityLink=(id,text)=>link(text||id,{entity:id});
const predLink=id=>link(id,{predicate:id});
const ruleLink=id=>link(id,{rule:id});
const pill=(text,cls='')=>h('span',{class:'pill '+cls},text);
const layerPill=l=>l?pill(l,'ok'):null;
const fmt=n=>n==null?'':Number(n).toLocaleString('en');
const sayFact=f=>h('li',{},h('span',{class:'say'},f.sentence),' ',h('span',{class:'arrow'},'→ '),h('code',{class:'atom'},f.atom),' ',layerPill(f.layer),f.source?h('span',{class:'ev'},' '+f.source):null,f.quote?h('span',{class:'ev'},' “'+f.quote+'”'):null);
const main=()=>$('app');
function show(...nodes){main().replaceChildren(...nodes);}
function fail(e){show(h('div',{class:'notice bad'},e.message));}
let memoriesCache=null;
async function memories(){return memoriesCache??=(await get('/v1/knowledge/memories')).data;}
async function pickers(){
 const list=await memories();
 const sel=$('target');if(!sel.options.length){for(const m of list)sel.append(h('option',{value:m.id},m.id+' — '+m.name));}
 if(!state.session&&!state.memory){const w=list.find(m=>m.id==='world-v1')??list[0];state.memory=w?.id;history.replaceState(null,'','/review?'+qs(state));}
 sel.value=state.memory||'';$('session-note').replaceChildren(state.session?h('span',{},'Chat session ',h('code',{},state.session),' (its base memory, layers and session layer). ',h('a',{href:'/review?'+qs({memory:list[0]?.id})},'Leave the session')):'');
 sel.disabled=Boolean(state.session);
 $('q').value=state.q||'';
}
async function render(){
 try{await pickers();
  if(state.entity)return await entityCard();
  if(state.predicate)return await predicateCard();
  if(state.rule)return await ruleCard();
  if(state.q)return await searchView();
  if(state.view==='memories'||(!state.memory&&!state.session))return await memoriesView();
  if(state.session)return await searchHelp();
  return await memoryView();
 }catch(e){fail(e);}
}
async function searchHelp(){show(h('div',{class:'card'},h('p',{},'Search what this chat session knows: entities, classes, predicates (labels, aliases and the forms people use), rules and text values of facts. Entity and predicate names in the chat trace open their cards here.')));}
async function memoriesView(){
 const list=await memories();
 show(h('h2',{},'Base memories'),...list.map(m=>h('section',{class:'card'},
  h('h3',{},link(m.name,{memory:m.id,view:'memory'}),' ',h('code',{},m.id),m.seed?pill('seed: config/knowledge/'+m.id):null),
  h('p',{class:'muted'},m.description||''),
  h('p',{},'Layers: ',...m.layers.map(l=>pill(l)),' · ',h('span',{title:'SOP wires by type: '+Object.entries(m.wires_by_type||{}).map(([t,n])=>fmt(n)+' '+t).join(', ')},fmt(m.knowledge_files??m.circuits),' knowledge files · ',fmt(m.sop_wires??0),' SOP wires'),' · ',h('span',{class:'ev',title:'index for fast lookup'},fmt(m.facts),' facts in the store'),m.ingestions.length?' · '+m.ingestions.length+' ingestion(s)':''),
  provenanceTable(m.provenance))));
}
function provenanceTable(rows){
 if(!rows?.length)return h('p',{class:'muted'},'No provenance records.');
 return h('table',{},h('tr',{},h('th',{},'kind'),h('th',{},'by'),h('th',{},'source'),h('th',{class:'num'},'records'),h('th',{class:'num'},'wires'),h('th',{class:'num'},'facts'),h('th',{},'when')),
  ...rows.map(r=>h('tr',{},h('td',{},r.kind),h('td',{},r.by??''),h('td',{},r.source),h('td',{class:'num'},fmt(r.records)),h('td',{class:'num'},fmt(r.wires)),h('td',{class:'num'},fmt(r.facts)),h('td',{},(r.first||'').slice(0,10)+(r.last&&r.last!==r.first?' … '+r.last.slice(0,10):'')))));
}
async function memoryView(){
 show(h('p',{class:'muted'},'Loading '+state.memory+'… (a large memory is parsed once)'));
 const m=await get('/v1/knowledge/memories/'+encodeURIComponent(state.memory));
 const layer=state.layer||m.layers.at(-1).id;
 const layers=h('table',{},h('tr',{},h('th',{},'layer'),h('th',{},'kind'),h('th',{class:'num'},'files'),h('th',{class:'num'},'wires'),h('th',{class:'num'},'entities'),h('th',{class:'num'},'facts'),h('th',{class:'num'},'items'),h('th',{class:'num'},'flagged'),h('th',{},'flags')),
  ...m.layers.map(l=>h('tr',{},h('td',{},link(l.id,{memory:m.id,view:'memory',layer:l.id})),h('td',{},l.kind+(l.seed?' ('+l.seed.source+')':'')),h('td',{class:'num'},fmt(l.files)),h('td',{class:'num'},fmt(Object.entries(l.wires).filter(([t])=>t!=='fact'&&t!=='entity').reduce((n,[,v])=>n+v,0))),h('td',{class:'num'},fmt(l.entities)),h('td',{class:'num'},fmt(l.facts)),h('td',{class:'num'},fmt(l.stats.items)),h('td',{class:'num'},fmt(l.stats.flagged)),h('td',{},...Object.entries(l.stats.flags).map(([k,v])=>pill(k+' '+v,'warn'))))));
 const parts=[h('h2',{},m.name,' ',h('code',{},m.id)),h('p',{class:'muted'},m.info?.description||''),h('section',{class:'card'},h('h3',{},'Layers'),layers,h('p',{class:'muted'},'An import layer is a snapshot taken when the memory was created; a seed layer ships in config/knowledge/. Flags mark likely problems worth a look; nothing here is approved or rejected by hand: corrections go through tests and interactions.')),
  h('section',{class:'card'},h('h3',{},'Provenance'),provenanceTable(m.provenance))];
 if(m.evidence?.reports?.length)parts.push(h('p',{},'Reports: ',...m.evidence.reports.map(r=>h('a',{href:'/experiments/report?path='+encodeURIComponent(r)},r)),' · corpus evidence ',m.evidence.available.mined?pill('available','ok'):pill('not on this checkout','bad')));
 if(m.ingestions?.length)parts.push(h('section',{class:'card'},h('h3',{},'Document ingestions'),h('table',{},h('tr',{},h('th',{},'ingestion'),h('th',{},'status'),h('th',{},'documents'),h('th',{},'chunks'),h('th',{},'created')),...m.ingestions.map(i=>h('tr',{},h('td',{},h('a',{href:'/v1/memories/'+m.id+'/ingestions/'+i.id},i.id)),h('td',{},i.status),h('td',{},i.documents.join(', ')),h('td',{},i.totals?i.totals.validated+'/'+i.totals.chunks+' validated, '+JSON.stringify(i.totals.wires):''),h('td',{},(i.created_at||'').slice(0,16)))))));
 if(m.mapping)parts.push(h('section',{class:'card'},h('details',{class:'more'},h('summary',{},'world-v1 mapping table: '+m.mapping.rows.length+' rows (Wikidata property → predicate)'),h('table',{},h('tr',{},h('th',{},'property'),h('th',{},'predicate'),h('th',{},'args'),h('th',{},'kind'),h('th',{},'scope'),h('th',{class:'num'},'facts built'),h('th',{},'note')),
  ...m.mapping.rows.map(r=>h('tr',{},h('td',{},h('a',{href:'https://www.wikidata.org/wiki/Property:'+r.pid,rel:'noopener'},r.pid)),h('td',{},predLink(r.pred),r.flip?pill('flipped','warn'):null,r.merged?pill('merged','warn'):null,r.curated?pill('curated'):null),h('td',{},h('code',{},r.args)),h('td',{},r.kind),h('td',{},r.scope.join(', ')),h('td',{class:'num'},fmt(r.facts_built)),h('td',{},r.note)))))));
 const box=h('section',{class:'card',id:'items'});parts.push(box);show(...parts);
 await itemsView(box,m,layer);
}
async function itemsView(box,m,layer){
 const query={layer,type:state.type,flag:state.flag,group:state.group,q:state.iq,offset:state.offset||0,limit:25};
 box.replaceChildren(h('p',{class:'muted'},'Loading the risk view of '+layer+'…'));
 const page=await get('/v1/knowledge/memories/'+encodeURIComponent(m.id)+'/items?'+qs(query));
 const nav=o=>link(o.text,{memory:m.id,view:'memory',layer,type:state.type,flag:state.flag,group:state.group,iq:state.iq,...o.set});
 const flagBar=h('div',{class:'bar'},'Flags: ',...Object.entries(page.stats.flags).sort((a,b)=>b[1]-a[1]).map(([k,v])=>h('a',{class:'pill'+(state.flag===k?' on':''),title:FLAG_TEXT[k]||k,href:href({view:'memory',layer,flag:state.flag===k?'':k,type:state.type}),'data-nav':'1'},k+' '+v)));
 const typeBar=h('div',{class:'bar'},'Types: ',...Object.entries(page.stats.types).map(([k,v])=>h('a',{class:'pill'+(state.type===k?' on':''),href:href({view:'memory',layer,type:state.type===k?'':k,flag:state.flag}),'data-nav':'1'},k+' '+v)));
 const filter=h('input',{type:'search',placeholder:'filter by id or summary',value:state.iq||''});filter.addEventListener('change',()=>go({view:'memory',layer,type:state.type,flag:state.flag,iq:filter.value.trim()}));
 const items=page.items.map(itemView);
 const more=h('p',{},page.offset>0?nav({text:'← previous',set:{offset:Math.max(0,page.offset-25)}}):'',' ',page.offset+page.items.length<page.total?nav({text:'next →',set:{offset:page.offset+25}}):'');
 box.replaceChildren(h('h3',{},'Risk view of layer ',h('code',{},layer),' — ',fmt(page.total),' item(s), most risk first'),flagBar,typeBar,h('div',{class:'bar'},filter),...items,more);
}
function examplesList(item){
 const ex=item.examples||[];if(!ex.length)return null;
 if(ex[0].derivation)return derivationView(ex[0]);
 return h('ul',{class:'ex'},...ex.map(x=>x.error?h('li',{class:'bad'},x.error):x.sentence&&x.links?h('li',{},h('span',{class:'say'},'“'+x.sentence+'”'),' ',h('span',{class:'arrow'},'→ '),h('code',{class:'atom'},x.atom),x.links.length>1?h('span',{class:'ev'},' (the lexicon links the phrase to '+x.links.join(', ')+')'):null,x.real?null:h('span',{class:'ev'},' placeholder names')):x.atom?sayFact(x):x.entity?h('li',{},entityLink(x.entity,x.label),x.description?h('span',{class:'ev'},' '+x.description):null):null));
}
function derivationView(d){
 const one=(x,label)=>h('div',{},h('div',{class:'ev'},label),h('ul',{class:'ex'},...x.facts.map(f=>h('li',{},h('span',{class:'say'},f.sentence),' ',h('code',{class:'atom'},f.atom))),h('li',{},'⇒ ',h('b',{class:'say'},x.head.sentence),' ',h('code',{class:'atom'},x.head.atom))));
 return h('div',{},...(d.real||[]).map((x,i)=>one(x,'Derivation '+(i+1)+' over stored facts:')),d.hypothetical?one(d.hypothetical,'No stored facts match; a hypothetical derivation over placeholder names:'):null,d.note?h('p',{class:'ev'},d.note):null);
}
function itemView(it){
 const title=it.type==='predicate'||it.type==='facts'?predLink(it.id):['rule','default','aggregate','integrity'].includes(it.type)?ruleLink(it.id):it.type==='class'?entityLink(it.id):it.type==='lexeme'?h('span',{},it.id,' of ',predLink(it.of)):h('span',{},it.id);
 const forms=it.forms?h('ul',{class:'ev'},...it.forms.map(f=>h('li',{},'“'+f.form+'”: ',f.evidence.mined?'mined '+f.evidence.mined.count+'×'+(f.evidence.mined.examples?.[0]?' — e.g. “'+f.evidence.mined.examples[0]+'”':''):'no corpus count',f.evidence.wikidata?.length?' · Wikidata '+f.evidence.wikidata.map(w=>w.pid+' '+w.label).join(', '):'',f.shared_with?.length?' · also '+f.shared_with.join(', '):'',f.role_variants?.length?' · role-set variants '+f.role_variants.join(', '):''))):null;
 const mapping=it.evidence?.mapping?.length?h('p',{class:'ev'},'Mapping: ',...it.evidence.mapping.map(r=>r.pid+(r.flip?' (flipped)':'')+' '+r.kind+' '+r.scope.join('/')+(r.note?' — '+r.note:'')+'; ')):null;
 const dropped=it.evidence?.dropped?.length?h('details',{class:'more ev'},h('summary',{},it.evidence.dropped.length+' dropped form(s)'),h('ul',{},...it.evidence.dropped.map(d=>h('li',{},'“'+d.form+'” — '+d.why)))):null;
 return h('div',{class:'item'},h('h3',{},it.risk?h('span',{class:'risk'},it.risk+' '):'',pill(it.type),' ',title,' ',pill(it.layer,'ok'),it.group?h('span',{class:'ev'},' '+it.group):null),
  h('div',{},it.summary||''),it.flags.length?h('ul',{class:'flags'},...it.flags.slice(0,8).map(f=>h('li',{},f.code+': '+f.message)),it.flags.length>8?h('li',{},'… '+(it.flags.length-8)+' more'):null):null,
  it.evidence?.source?h('div',{class:'ev'},'source: '+it.evidence.source):null,forms,mapping,dropped,examplesList(it));
}
async function searchView(){
 show(h('p',{class:'muted'},'Searching…'));
 const r=await get('/v1/knowledge/search?'+qs({...targetParams(),q:state.q,kind:state.kind,offset:state.offset,limit:state.kind?25:8}));
 const g=r.groups,sec=(name,title,row)=>{const x=g[name];if(!x||!x.total)return null;const nav=h('p',{},state.kind!==name&&x.total>x.items.length?link('all '+fmt(x.total)+' →',{q:state.q,kind:name}):'',state.kind===name&&x.offset>0?link('← previous',{q:state.q,kind:name,offset:Math.max(0,x.offset-25)}):'',' ',state.kind===name&&x.offset+x.items.length<x.total?link('next →',{q:state.q,kind:name,offset:x.offset+25}):'');return h('section',{class:'card group'},h('h2',{},title+' ('+fmt(x.total)+')'),h('ul',{class:'plain'},...x.items.map(row)),nav);};
 show(h('p',{class:'muted'},fmt(r.total)+' result(s) for “'+state.q+'”'+(state.kind?' · '+state.kind:'')+' ',state.kind?link('all groups',{q:state.q}):''),
  sec('entities','Entities',e=>h('li',{},entityLink(e.id,e.label),' ',pill(e.class),e.description?h('span',{class:'ev'},' '+e.description):null,e.matched&&e.matched!==e.label?h('span',{class:'ev'},' (matched “'+e.matched+'”)'):null,' ',layerPill(e.layer))),
  sec('classes','Classes',e=>h('li',{},entityLink(e.id,e.label),' ',layerPill(e.layer))),
  sec('predicates','Predicates',p=>h('li',{},predLink(p.id),' ',p.description?h('span',{class:'ev'},p.description):null,p.matched&&p.matched!=='description'?h('span',{class:'ev'},' (form “'+p.matched+'”)'):null,p.facts?h('span',{class:'ev'},' · '+fmt(p.facts)+' facts in circuits'):null)),
  sec('rules','Rules',x=>h('li',{},ruleLink(x.id),' ',pill(x.type),' ',x.body.join(' + ')+(x.head?' → '+x.head:''),' ',layerPill(x.layer))),
  sec('facts','Facts (text values)',f=>h('li',{},h('span',{class:'say'},f.sentence),' ',h('code',{class:'atom'},f.atom),' ',f.subject?entityLink(f.subject,'card'):null,' ',layerPill(f.layer))))||null;
 if(!r.total)main().append(h('p',{},'Nothing matches every word.'));
}
async function entityCard(){
 show(h('p',{class:'muted'},'Loading the entity card…'));
 const e=await get('/v1/knowledge/entities/'+encodeURIComponent(state.entity)+'?'+qs(targetParams()));
 const groups=e.facts.map(g=>h('div',{},h('h3',{},predLink(g.predicate),h('span',{class:'ev'},' — '+state.entity+' as '+g.role+' · '+g.facts.length)),h('ul',{class:'ex'},...g.facts.map(sayFact))));
 const derive=h('button',{class:'primary',onclick:async()=>{derive.disabled=true;out.replaceChildren(h('p',{class:'muted'},'Asking the oracle…'));try{showDerive(out,await get('/v1/knowledge/derive?'+qs({...targetParams(),entity:e.id})));}catch(x){out.replaceChildren(h('p',{class:'bad'},x.message));}derive.disabled=false;}},'Derive');
 const out=h('div',{});
 show(h('h2',{},e.label,' ',h('code',{},e.id),' ',pill(e.class),' ',layerPill(e.layer)),
  h('section',{class:'card'},e.description?h('p',{},e.description):null,h('p',{},'Classes: ',...e.classes.map(c=>entityLink(c.id,c.label)).flatMap((x,i)=>i?[', ',x]:[x])),
   h('p',{class:'ev'},'Aliases: '+e.aliases.map(a=>a.surface+(a.derived?' ('+a.derived+')':'')).join(', ')+(e.notability?' · notability '+e.notability:'')),
   e.subclasses.length?h('p',{},'Subclasses: ',...e.subclasses.map(c=>entityLink(c)).flatMap((x,i)=>i?[', ',x]:[x])):null,
   e.members.length?h('p',{},'Some members: ',...e.members.map(x=>entityLink(x.id,x.label)).flatMap((x,i)=>i?[', ',x]:[x])):null),
  h('section',{class:'card'},h('h3',{},fmt(e.facts_total)+' stored fact(s)'),...groups,h('p',{class:'ev'},e.note)),
  h('section',{class:'card'},h('h3',{},'Rules that can derive more ('+e.rules.length+')'),h('ul',{class:'plain'},...e.rules.map(r=>h('li',{},ruleLink(r.id),' ',r.body.join(' + ')+' → '+r.head,' ',layerPill(r.layer)))),derive,out));
}
function showDerive(out,d){
 const node=(n,byId,depth)=>h('div',{class:'proof'},h('span',{class:'say'},n.sentence),' ',h('code',{class:'atom'},n.atom),' ',n.kind==='rule'?h('span',{},'by ',ruleLink(n.source)):h('span',{class:'ev'},'stored fact '),n.layer?layerPill(n.layer):null,depth<6?n.premises.map(p=>byId[p]?node(byId[p],byId,depth+1):null):null);
 out.replaceChildren(h('p',{},fmt(d.derived.length)+' derived fact(s) not stored; '+d.explained+' explained. Asked: '+d.asked.map(a=>a.predicate+'#'+a.position+' '+(a.status||a.error)).join(', ')),
  ...d.derived.map((x,i)=>h('div',{},h('b',{class:'say'},x.sentence),' ',h('code',{class:'atom'},x.atom),x.proof?(()=>{const byId=Object.fromEntries(x.proof.map(n=>[n.id,n]));return h('details',{class:'more',open:i<3},h('summary',{},'proof'),...(x.roots||[]).map(r=>byId[r]?node(byId[r],byId,0):null));})():null)),h('p',{class:'ev'},d.note));
}
async function predicateCard(){
 show(h('p',{class:'muted'},'Loading the predicate card…'));
 const p=await get('/v1/knowledge/predicates/'+encodeURIComponent(state.predicate)+'?'+qs(targetParams()));
 const sentences=h('ul',{class:'ex'},...p.sentences.map(x=>h('li',{},h('span',{class:'say'},'“'+x.sentence+'”'),' → ',h('code',{class:'atom'},x.atom),x.links.length>1?h('span',{class:'ev'},' (also linked to '+x.links.filter(y=>y!==p.id).join(', ')+')'):null)));
 const lexemes=h('table',{},h('tr',{},h('th',{},'lexeme'),h('th',{},'pos / frame'),h('th',{},'forms and evidence')),...p.lexemes.map(l=>h('tr',{},h('td',{},h('code',{},l.id),l.converse?pill('converse','warn'):null),h('td',{},l.pos+' / '+l.frame.join(' ')),h('td',{},h('ul',{class:'plain'},...l.forms.map(f=>h('li',{},'“'+f.form+'” ',f.evidence.mined?pill('mined '+f.evidence.mined.count,'ok'):null,...(f.evidence.wikidata||[]).map(w=>pill(w.pid,'ok')),...f.flags.map(x=>pill(x.code,'bad')),f.shared_with?.length?h('span',{class:'ev'},' also '+f.shared_with.join(', ')):null))),l.source?h('div',{class:'ev'},'source: '+l.source):null))));
 show(h('h2',{},p.label,' ',h('code',{},p.id),' ',layerPill(p.layer)),
  h('section',{class:'card'},h('p',{},p.description||h('span',{class:'bad'},'No description.')),h('p',{},'Roles: ',p.roles.map(r=>r.name+' ('+r.type+')').join(', '),' · ',p.closed?pill('closed list','warn'):pill('open world'),...(p.readings||[]).map(r=>pill('reading '+r))),
   h('p',{class:'ev'},'Declared in '+(p.layer||'?')+' '+(p.file||'')+' · facts in circuits: '+(p.facts.map(x=>x.layer+' '+fmt(x.facts)).join(', ')||'none')),
   p.mapping.length?h('p',{class:'ev'},'Wikidata: ',...p.mapping.map(r=>h('span',{},h('a',{href:'https://www.wikidata.org/wiki/Property:'+r.pid,rel:'noopener'},r.pid),' '+r.kind+(r.flip?' flipped':'')+' ('+r.scope.join(', ')+') '+r.note+'; '))):null),
  h('section',{class:'card'},h('h3',{},'How people say it'),sentences,lexemes,p.dropped.length?h('details',{class:'more ev'},h('summary',{},p.dropped.length+' form(s) dropped by the build'),h('ul',{},...p.dropped.map(d=>h('li',{},'“'+d.form+'” — '+d.why)))):null),
  h('section',{class:'card'},h('h3',{},'Example facts'),p.examples.length?h('ul',{class:'ex'},...p.examples.map(sayFact)):h('p',{class:'muted'},'No stored facts.')),
  h('section',{class:'card cols'},h('div',{},h('h3',{},'Concluded by'),h('ul',{class:'plain'},...p.concluded_by.map(r=>h('li',{},ruleLink(r.id),' ',r.body.join(' + '),' ',layerPill(r.layer))))),h('div',{},h('h3',{},'Used by'),h('ul',{class:'plain'},...p.used_by.map(r=>h('li',{},ruleLink(r.id),' → ',r.head,' ',layerPill(r.layer)))))));
}
async function ruleCard(){
 show(h('p',{class:'muted'},'Loading the rule card…'));
 const r=await get('/v1/knowledge/rules/'+encodeURIComponent(state.rule)+'?'+qs(targetParams()));
 show(h('h2',{},r.id,' ',pill(r.type),' ',layerPill(r.layer)),
  h('section',{class:'card'},r.description?h('p',{},r.description):null,r.english?h('p',{},r.english):null,h('p',{},'Uses ',...r.body.map(predLink).flatMap((x,i)=>i?[', ',x]:[x]),r.head?[' → ',predLink(r.head)]:''),h('pre',{},r.sop),h('p',{class:'ev'},'file '+r.file+(r.source?' · source: '+r.source:'')+(r.quote?' · “'+r.quote+'”':''))),
  r.example?h('section',{class:'card'},h('h3',{},'Example derivation'),derivationView(r.example)):null);
}
$('search').addEventListener('submit',e=>{e.preventDefault();const q=$('q').value.trim();go(q?{q}:{view:'memory'});});
$('target').addEventListener('change',()=>{state={memory:$('target').value,view:'memory'};history.pushState(null,'','/review?'+qs(state));render();});
render();
`;

export const reviewPage = ({signedIn = false} = {}) => layout({
  title: 'MRP-LLM knowledge browser', active: 'review', signedIn, style,
  body: `<main class="wrap"><h1>Knowledge browser</h1>
<p class="muted">What a base memory or a chat session knows, layer by layer, with provenance and evidence. Flags mark likely problems (a form with no evidence, a form two predicates share, a flipped mapping); there is no approve or reject step: corrections go through tests and interactions.</p>
<form id="search" class="bar" role="search"><label for="target" class="muted" style="margin:0">Memory</label><select id="target" aria-label="Base memory"></select><input id="q" type="search" placeholder="search entities, predicates, forms, rules, fact values" aria-label="Keywords"><button class="primary" type="submit">Search</button><a class="button" href="/review?view=memories">All memories</a></form>
<div id="session-note" class="muted"></div>
<div id="app" class="muted">loading…</div></main>`,
  script,
});
