/** Administrator page: server status and API token management. Signing in and
 * choosing the first password happen on `/login`; this page reads
 * `/admin/status` and calls the session-protected `/admin/token*` endpoints. */
import {layout} from './layout.mjs';

const script = `
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const api=async(route,options)=>{const response=await fetch(route,{credentials:'same-origin',...options});const body=await response.json().catch(()=>({}));return {status:response.status,body}};
const post=(route,payload)=>api(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload??{})});
function show(html){$('app').innerHTML=html}
async function render(){
 const s=(await api('/admin/status')).body;
 if(!s.configured){show('<div class="card"><p>No administrator password yet. <a class="button primary" href="/login?next=%2Fadmin">Set the administrator password</a></p></div>');return;}
 if(!s.authenticated){show('<div class="card"><p>You are not signed in. <a class="button primary" href="/login?next=%2Fadmin">Sign in</a></p></div>');return;}
 const tokens=(s.tokens??[]).map(t=>'<li><code>'+esc(t.id)+'</code> '+esc(t.label)+' <span class="muted">created '+esc(t.created)+'</span> <button data-revoke="'+esc(t.id)+'">revoke</button></li>').join('')||'<li class="muted">none yet</li>';
 show('<div class="grid"><a class="tile" href="/chat"><b>Chat</b><span>Open the chat</span></a><a class="tile" href="/experiments"><b>Experiments</b><span>Tasks, notes and reports</span></a></div>'+
  '<section class="card"><h2>Status</h2><ul class="plain"><li>Formalizer ready: <b class="'+(s.ready?'ok':'bad')+'">'+(s.ready?'yes':'no')+'</b> <span class="muted">(chat answers return 503 parse_unavailable until omp can run a model of the chain; see the home page)</span></li>'+
  '</ul></section>'+
  '<section class="card" id="feedback"><h2>Chat feedback</h2><p class="muted">loading…</p></section>'+
  '<section class="card"><h2>API tokens</h2><p class="muted">For curl, SDKs and scripts: send <code>Authorization: Bearer &lt;token&gt;</code>. A token is shown once.</p><p><input id="label" placeholder="label, e.g. laptop" maxlength="40"> <button class="primary" id="mint">Create token</button></p><div id="fresh"></div><ul class="plain">'+tokens+'</ul></section>');
 $('mint').onclick=mint;
 composer();
 feedbackView();
 $('app').querySelectorAll('[data-revoke]').forEach(button=>{button.onclick=()=>revoke(button.dataset.revoke)});
}
// Chat feedback (DS022 "Chat feedback"): the recent votes of GET /v1/feedback grouped by cause, each linked to its recorded turn.
const CAUSES={not_understood:'Did not understand the request',wrong_answer:'Wrong answer',missing_knowledge:'Missing knowledge',unnecessary_question:'Unnecessary question',bad_wording:'Bad wording or tone',up:'Thumbs up'};
async function feedbackView(){
 const r=await api('/v1/feedback?limit=300');const box=$('feedback');
 if(r.status!==200){box.innerHTML='<h2>Chat feedback</h2><p class="muted">Not available: '+esc(r.body.error?.message??('HTTP '+r.status))+'</p>';return;}
 const st=r.body.stats;const short=v=>esc(String(v??'').slice(0,160));
 const counts='<p>'+st.votes.up+' up, '+st.votes.down+' down over '+st.turns+' turns (latest vote of each turn). '+Object.entries(st.causes).map(([c,n])=>esc(CAUSES[c])+': <b>'+n+'</b>').join(' · ')+'</p>';
 const group=([cause,rows])=>rows.length?'<h3>'+esc(CAUSES[cause]??cause)+' <span class="muted">('+rows.length+')</span></h3><div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Message</th><th>Answer</th><th>Comment</th><th>Turn</th></tr></thead><tbody>'+
  rows.map(x=>'<tr><td>'+esc(String(x.t).slice(0,16).replace('T',' '))+'</td><td>'+short(x.record?.message)+'</td><td>'+short(x.record?.answer)+'</td><td>'+short(x.comment)+'</td><td><a href="/v1/sessions/'+encodeURIComponent(x.session)+'/turns/'+x.turn+'">'+esc(x.session)+' #'+x.turn+'</a></td></tr>').join('')+'</tbody></table></div>':'';
 const body=Object.entries(r.body.groups).map(group).join('');
 box.innerHTML='<h2>Chat feedback</h2>'+counts+(body||'<p class="muted">No votes yet.</p>');
}
// The base-memory composer (DS022 "Composing a base memory"): choose layers with checkboxes, build or refresh a memory through POST /v1/memory-composer.
let layers=[],info={};
async function composer(){
 const r=await api('/v1/memory-composer');const box=$('composer');
 if(r.status!==200){box.innerHTML='<h2>Base memory composer</h2><p class="muted">Not available: '+esc(r.body.error?.message??('HTTP '+r.status))+'</p>';return;}
 info=r.body;layers=info.layers;
 const targets=[info.reply_memory,info.default_base,...layers.filter(l=>l.composition).map(l=>l.id)].filter((v,i,a)=>v&&a.indexOf(v)===i);
 const tag=l=>[l.seed?'seed':'memory',l.role==='conversation'?'conversation':'',l.group?'group '+l.group:'',l.stale?'<span class="bad">stale</span>':''].filter(Boolean).join(' · ');
 const size=l=>l.counts?.replies!=null?l.counts.replies+' replies':(l.facts?l.facts.toLocaleString()+' facts':'')+(l.circuits?' · '+l.circuits+' circuits':'');
 box.innerHTML='<h2>Base memory composer</h2><p class="muted">Build or refresh a base memory from prepared layers (DS022). The chat replies come from <code>'+esc(info.reply_memory??'conversation-v1')+'</code>; new sessions fork <code>'+esc(info.default_base??'')+'</code>. A memory with circuits of its own, or a seed, is never replaced.</p>'+
  '<p>Target <select id="cmp-target">'+targets.map(t=>'<option>'+esc(t)+'</option>').join('')+'<option value="">new memory…</option></select> id <input id="cmp-id" maxlength="64" size="22"> name <input id="cmp-name" maxlength="120" size="26"></p>'+
  '<ul class="plain">'+layers.map(l=>'<li><label><input type="checkbox" data-layer="'+esc(l.id)+'"> <b>'+esc(l.id)+'</b> '+esc(l.name)+' <span class="muted">('+tag(l)+(size(l)?'; '+esc(size(l)):'')+')</span></label><br><span class="muted">'+esc(String(l.description).slice(0,220))+'</span></li>').join('')+'</ul>'+
  '<p><button class="primary" id="cmp-build">Build or refresh</button> <span id="cmp-out"></span></p>';
 $('cmp-target').onchange=pick;$('cmp-build').onclick=build;pick();
}
function pick(){
 const id=$('cmp-target').value,m=layers.find(l=>l.id===id);
 $('cmp-id').value=id;$('cmp-name').value=m?.name??'';
 const chosen=new Set(m?.composition?.layers??m?.imports??[]);
 document.querySelectorAll('[data-layer]').forEach(c=>{c.checked=chosen.has(c.dataset.layer);c.disabled=c.dataset.layer===id});
}
async function build(){
 const chosen=[...document.querySelectorAll('[data-layer]')].filter(c=>c.checked).map(c=>c.dataset.layer);
 $('cmp-out').textContent='building…';
 const r=await post('/v1/memory-composer',{id:$('cmp-id').value.trim(),name:$('cmp-name').value.trim()||undefined,layers:chosen});
 if(r.status!==201){$('cmp-out').innerHTML='<span class="bad">'+esc(r.body.error?.message??('HTTP '+r.status))+'</span>'+(r.body.error?.problems?'<br><span class="muted">'+esc(r.body.error.problems.slice(0,3).map(p=>p.message??p).join('; '))+'</span>':'');return;}
 $('cmp-out').innerHTML='<span class="ok">'+(r.body.replaced?'refreshed':'built')+'</span> '+esc(r.body.id)+': '+r.body.imports.length+' layers, '+Number(r.body.facts).toLocaleString()+' facts, '+r.body.ms+' ms'+(r.body.reply_layer?'; the chat now replies from it':'');
 await composer();
}
async function mint(){const r=await post('/admin/token',{label:$('label').value.trim()||'minted in admin'});if(r.status!==200){$('fresh').innerHTML='<p class="bad">'+esc(r.body.error?.message??('HTTP '+r.status))+'</p>';return;}await render();$('fresh').innerHTML='<p class="notice">Copy it now, it is shown once: <code>'+esc(r.body.token)+'</code></p>';}
async function revoke(id){await post('/admin/token/revoke',{id});render()}
render();
`;

export const adminPage = ({signedIn = false} = {}) => layout({title: 'MRP-LLM admin', active: 'admin', signedIn, body: '<main class="wrap"><h1>Admin</h1><div id="app" class="muted">loading…</div></main>', script});
