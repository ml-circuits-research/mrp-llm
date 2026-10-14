/** SOP Lang: line-oriented, multiline typed wires. The grammar serves trusted circuits
 * and the model language; sop/declarative.mjs decides which wire types the model may author. */
import {captureCircuit,captureEnabled} from '../lib/circuit-capture.mjs';
import {expandCompact} from './compact.mjs';
import {outputRegistry,outputSpecs} from './outputs.mjs';
import {assert,stable} from '../lib/util.mjs';
import {ENUMS,POLARITIES,CERTAINTIES,BASES,ROLE_NAMES,VALIDITY_FORMS,COMPARATOR_WORDS,RANK_WORDS,RANK_CUTS,QUANTIFIER_WORDS,ORDER_WORDS,ORDER_SAMPLING,ORDER_SAMPLING_MODES,LINK_WORDS,MAX_LINKS,UNPARSED_HINTS,MAX_SPAN,PRAGMATIC_KIND_FORM,PRAGMATIC_BASES,INSTRUCTION_ACTIONS,INSTRUCTION_KINDS,INSTRUCTION_TEXT_KINDS} from './enums.mjs';
export {ENUMS,POLARITIES,CERTAINTIES,BASES,ROLE_NAMES,VALIDITY_FORMS,OUTPUT_MODES,QUERY_MODES,TIME_MEASURES,COMPARATOR_WORDS,ARITHMETIC_WORDS,RANK_WORDS,RANK_CUTS,QUANTIFIER_WORDS,ORDER_WORDS,FRAGMENT_KINDS,LINK_KEYWORDS,LINK_WORDS,LINK_TYPES,MAX_LINKS,LINK_STATUSES,UNPARSED_HINTS,GENERIC_HINTS,MAX_SPAN} from './enums.mjs';
import {parseExpression,expressionRefs,evaluateExpression} from './expression.mjs';
import {messageActs} from './message-acts.mjs';
import {conditionField,parseCondition,parseBooleanCondition,formatCondition,BLOCK_OPENERS,BLOCK_CLOSER} from './conditions.mjs';
export {GROUP_OPENERS,MATCH_OPENER,BLOCK_OPENERS,BLOCK_CLOSER,SYNTAX_WORDS,CONDITION_FIELDS} from './conditions.mjs';
/** The atom negation prefix (`[not ]predicate term…`) and the keyword lines of a query `match` block (DS014). */
export const ATOM_NEGATION='not';
export const MATCH_KEYWORDS=Object.freeze(['relation','role','polarity']);
export const SPEC={
 value:{one:['data'],required:['data']},
 resolve:{one:['text','language','kind','type','domain'],required:['text','language','kind']},
 fact:{one:['holds','valid','source','quote','retention'],required:['holds','valid']},
 stated:{one:['relation','polarity','certainty','speaker'],many:['role','valid',...LINK_WORDS],required:['relation','role','polarity','certainty']},
 assumed:{one:['relation','polarity','basis'],many:['role','valid',...LINK_WORDS],required:['relation','role','polarity']},
 unclear:{one:['kind','language'],many:['reading'],required:['kind']},
 unparsed:{one:['span','near','hint'],required:['span']},
 pragmatic:{one:['kind','score','span','near','source','basis'],required:['kind','basis']},
 instruction:{one:['do','kind','text','span','source'],required:['do']},
 rule:{one:['then','valid','mode','source'],many:['when'],required:['then','when']},
 query:{one:['mode','select','scope','measure','span','at','during','overlaps','asof','limit','rank','quantifier','order','fragment'],many:['where','filter','compare','except','candidate',...LINK_WORDS],required:[]},
 constraint:{one:['claim','task','unit','objective','direction','select'],many:['var','require'],required:[]},
 event:{one:['action','target','effective','replacement','source'],required:['action','target']},
 pack:{many:['items'],required:['items']},
 remember:{one:['scope'],many:['input','after'],required:['input']},
 recall:{one:['query','strategy'],many:['after'],required:['query']},
 link:{one:['query','data','strategy'],many:['after'],required:['query']},
 solve:{one:['query','constraint','data','backend','strategy','assume','reasoning'],many:['output','after']},
 binding:{one:['result','variable','mode','owner'],required:['result','variable','mode','owner']},
 reason:{one:['query','memory','data','constraint','backend','assume','reasoning','mode'],many:['after']},
 cnl:{one:['result','language'],required:['result']},
 jsEval:{one:['expr'],required:['expr']},
 template:{one:['params','yield','body','description'],many:['cue'],required:['body','yield']},
 expand:{one:['using'],many:['with','after'],required:['using']},
 clarify:{one:['text'],required:['text']},
 pattern:{one:['then','support','coverage','samples','counterexamples','source','status'],many:['when'],required:['when','then']},
 hypothesis:{one:['holds','cost','status','source'],many:['assume']},
 action:{one:['params','cost','source','valid'],many:['requires','adds','removes'],required:['requires']},
 goal:{many:['where'],required:['where']},
 trace:{one:['text','source','closed','known'],many:['feature']},
 policy:{one:['maxNodes','maxDepth','maxHypotheses','maxCandidates','maxPlans','timeoutMs']},
 theory:{one:['dialect','body'],required:['dialect','body']},
 procedure:{one:['params','yield','body','description'],many:['cue'],required:['body','yield']},
 abduce:{one:['query','data','memory','observation','candidates','reasoning','policy'],many:['output','after']},
 diagnose:{one:['query','data','memory','observation','candidates','tests','reasoning','policy'],many:['output','after']},
 associate:{one:['cue','data','mode','reasoning','policy'],many:['output','after'],required:['cue','data']},
 induce:{one:['data','candidates','holdout','reasoning','policy'],many:['output','after'],required:['data']},
 analogize:{one:['source','target','transfer','reasoning','policy'],many:['output','after'],required:['source','target']},
 plan:{one:['data','memory','actions','goal','reasoning','policy'],many:['output','after'],required:['goal']},
 simulate:{one:['query','data','memory','intervention','mode','reasoning','policy'],many:['output','after'],required:['query','intervention']},
 temporal:{one:['query','data','memory','reasoning','policy'],many:['output','after'],required:['query']}
};
const specOf=(type)=>SPEC[type];
export function words(s){return s.match(/"(?:\\.|[^"\\])*"|\S+/g)??[];}
export function unquote(s){return s?.startsWith('"')?JSON.parse(s):s;}
export function parseTerm(s){if(/^\$[A-Za-z][A-Za-z0-9_]*$/.test(s))return {ref:s.slice(1)};if(/^\?[A-Za-z][A-Za-z0-9_]*$/.test(s))return s;if(s.startsWith('"')){const v=JSON.parse(s);assert(typeof v==='string','String term required');return v;}if(/^-?\d+$/.test(s)){const n=Number(s);assert(Number.isSafeInteger(n),'Safe integer expected');return n;}if(/^-?\d+\.\d+$/.test(s)){const n=Number(s);assert(Number.isFinite(n),'Finite decimal expected');return n;}assert(/^[a-z][a-z0-9_:-]*$/.test(s),'Invalid canonical term '+s);return s;}
export function parseAtom(text,{absence=false}={}){
 assert(typeof text==='string'&&!/[\r\n]/.test(text),'An atom occupies one line');
 const head=text.match(absence?/^(not[ \t]+|absent[ \t]+(?=[a-z][a-z0-9_]*[ \t]+\S))?([a-z][a-z0-9_]*)[ \t]+/:/^(not[ \t]+)?([a-z][a-z0-9_]*)[ \t]+/);
 assert(head&&head[2]!=='not','Expected [not] predicate term1 term2; not is reserved');
 const token=/"(?:\\.|[^"\\\r\n])*"|[^\s"]+/y,a=[];
 let cursor=head[0].length;
 while(cursor<text.length){
  token.lastIndex=cursor;const match=token.exec(text);
  assert(match,'Expected a complete atom term or quoted string');
  a.push(parseTerm(match[0]));assert(a.length<=4,'An atom takes 1..4 arguments');
  cursor=token.lastIndex;
  assert(cursor===text.length||/[ \t]/.test(text[cursor]),'Atom terms must be separated by whitespace');
  while(cursor<text.length&&/[ \t]/.test(text[cursor]))cursor++;
 }
 assert(a.length>=1,'An atom takes 1..4 arguments');
 return {p:head[2],a,neg:head[1]?.trim()==='absent'?'absent':!!head[1]};
}
export function emitTerm(x){if(x&&typeof x==='object'&&x.ref)return '$'+x.ref;if(typeof x==='number')return String(x);if(/^\?[A-Za-z][A-Za-z0-9_]*$/.test(x))return x;return /^[a-z][a-z0-9_:-]*$/.test(x)?x:JSON.stringify(x);}
export const emitAtom=a=>(a.neg==='absent'?'absent ':a.neg?'not ':'')+a.p+' '+a.a.map(emitTerm).join(' ');
export function scalar(text,values={}){if(/^\$[A-Za-z][A-Za-z0-9_]*$/.test(text)){const n=text.slice(1);assert(Object.hasOwn(values,n),'Unresolved $'+n);return values[n];}return unquote(text);}
export function parse(source,{maxWires=2048,maxBytes=1048576,allowTypes=null}={}){
 if(captureEnabled)captureCircuit(source,'model');
 // The compact surface (`@id type key=value`, `  key=value`) is rewritten to the canonical one first (sop/compact.mjs, DS024).
 if(typeof source==='string')source=expandCompact(source);
 assert(typeof source==='string'&&Buffer.byteLength(source)<=maxBytes,'SOP source size limit');const lines=source.replace(/\r\n/g,'\n').split('\n'),wires=[];let current=null;
 for(let i=0;i<lines.length;i++){const line=lines[i];if(!line.trim()||line.trimStart().startsWith('#'))continue;
  if(/^@/.test(line)){const m=line.match(/^@([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*)\s*$/);assert(m,`Line ${i+1}: expected @name type`);assert(!wires.some(w=>w.id===m[1]),'Duplicate wire @'+m[1]);assert(SPEC[m[2]]||(allowTypes??[]).includes(m[2]),'Unknown wire type '+m[2]);assert(!['constructor','prototype','__proto__'].includes(m[1]),'Reserved wire name');current={id:m[1],type:m[2],fields:{},line:i+1};wires.push(current);assert(wires.length<=maxWires,'Too many wires');continue;}
  assert(current&&/^  \S/.test(line),`Line ${i+1}: wire fields use two spaces`);const m=line.trim().match(/^(\S+)(?:\s+(.*))?$/),key=m[1];let value=m[2]??'';
  const spec=specOf(current.type);assert(!spec||(spec.one??[]).includes(key)||(spec.many??[]).includes(key),'Unsupported field '+key+' on '+current.type);
  if(value==='|'){const chunk=[];while(i+1<lines.length){const next=lines[i+1];if(next.trim()&&!next.startsWith('    '))break;i++;chunk.push(next.startsWith('    ')?next.slice(4):'');}value=chunk.join('\n').replace(/\s+$/,'');}
  else if(conditionField(current.type,key)&&BLOCK_OPENERS.includes(value)){
   const chunk=[value];let depth=1;
   while(depth&&i+1<lines.length){
    const next=lines[++i],text=next.trim();
    if(!text||text.startsWith('#'))continue;
    assert(/^  \s*\S/.test(next),`Line ${i+1}: unclosed condition group`);
    if(BLOCK_OPENERS.includes(text))depth++;
    if(text===BLOCK_CLOSER)depth--;
    assert(depth<=32,'Condition nesting limit');
    chunk.push(text);
   }
   assert(depth===0,'Unclosed condition group');value=chunk.join('\n');
  }
  current.fields[key]??=[];current.fields[key].push(value);if(spec&&(spec.one??[]).includes(key))assert(current.fields[key].length===1,'Duplicate '+key);
 }
 assert(wires.length>0,'Empty SOP program');for(const w of wires){const spec=specOf(w.type);for(const k of spec?.required??[])assert(w.fields[k]?.length,'@'+w.id+' needs '+k);validateShape(w);}
 return {wires};
}
export const one=(w,k,defaultValue=undefined)=>w.fields[k]?.[0]??defaultValue;
export const many=(w,k)=>w.fields[k]??[];
/** The sampling word of a query's `order` line (`order random`, ORDER_SAMPLING), or null for a temporal order or none. */
export const sampledOrder=w=>{const p=words(one(w,'order','')??'');return p.length===1&&ORDER_SAMPLING.includes(p[0])?p[0]:null;};
export function refsIn(text){let quoted=false,esc=false;const values=new Set(),handles=new Set();for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(!esc&&c==='"')quoted=false;if(!esc&&c==='\\')esc=true;else esc=false;continue;}if(c==='"'){quoted=true;continue;}if(c==='$'||c==='~'){const m=text.slice(i+1).match(/^[A-Za-z][A-Za-z0-9_]*/);if(m){(c==='$'?values:handles).add(m[0]);i+=m[0].length;}}}return {values:[...values],handles:[...handles]};}
export function dependencies(w){if(['template','procedure'].includes(w.type))return {values:[],handles:[]};const result={values:new Set(),handles:new Set()};for(const [key,vs]of Object.entries(w.fields)){if(['quote','text'].includes(key)||(key==='source'&&w.type!=='analogize'))continue;for(const text of vs){const r=refsIn(text);r.values.forEach(x=>result.values.add(x));r.handles.forEach(x=>result.handles.add(x));}}return {values:[...result.values],handles:[...result.handles]};}
const SYMBOL=/^[a-z][a-z0-9_]*$/;
/**
 * Model-language propositions are context-free strings (DS014): a quoted relation
 * phrase, roles from the closed inventory with quoted values, an explicit
 * polarity and optional quoted validity. `pairs` is [[keyword, value], …].
 * With `variables` (query `match` blocks) a value may also be a ?variable.
 */
export function parseProposition(pairs,{where='proposition',variables=false,validity=true,partial=false,references=true,placeholders=true,absence=false}={}){
 const text=(key,value)=>{assert(/^"/.test(value??''),where+' '+key+' takes one JSON-quoted string');const v=parseTerm(value);assert(typeof v==='string'&&v.trim(),where+' '+key+' needs a nonempty quoted string');return v;};
 const out={relation:undefined,roles:[],polarity:undefined,valid:{}},names=new Set();
 for(const [key,value] of pairs){
  if(key==='relation'){assert(out.relation===undefined,'Duplicate relation');out.relation=text('relation',value);continue;}
  if(key==='polarity'){assert(out.polarity===undefined,'Duplicate polarity');assert(POLARITIES.includes(value)||(absence&&value==='absent'),where+' polarity must be affirmed or negated'+(absence?' or absent':''));out.polarity=value;continue;}
  if(key==='role'){
   const parts=words(value);assert(parts.length===2,where+' role takes exactly NAME VALUE');
   const [name,token]=parts;assert(ROLE_NAMES.includes(name),'role_unknown: '+where+' role '+name+' is not one of '+ROLE_NAMES.join(', '));
   assert(!names.has(name),'role_duplicate: '+where+' repeats role '+name);names.add(name);
   let v;
   // In a stated/assumed wire a ?variable is only a placeholder for a span the model marked `unparsed` (paired by
   // `near` and `hint` at admission, sop/clauses.mjs); anywhere else it is a query unknown.
   if(/^\?[A-Za-z][A-Za-z0-9_]*$/.test(token)){assert(variables||placeholders,'proposition_not_ground: '+where+' role '+name+' cannot take a ?variable; put unknowns in a query');v=token;}
   else if(/^-?\d+(?:\.\d+)?$/.test(token))v=parseTerm(token);
   // A `$id` value names another wire of the same model output (DS014 "Clauses and links", owner decision L1):
   // the proposition of a stated/assumed wire used as an argument, or the answers of an earlier query.
   else if(/^\$[A-Za-z][A-Za-z0-9_]*$/.test(token)){assert(references,'proposition_not_ground: '+where+' role '+name+' cannot take a $reference');v={ref:token.slice(1)};}
   else {assert(!/^~/.test(token),'proposition_not_ground: '+where+' role '+name+' cannot take a ~handle');assert(!/^\$/.test(token),'reference_form: '+where+' role '+name+' takes $id, a wire name of this output');assert(token.startsWith('"'),where+' role '+name+' value must be a JSON-quoted string as written in the message'+(variables?', a ?variable':'')+' or a number (integer or decimal)');v=text('role '+name,token);assert(!/^[?$~]/.test(v),'proposition_not_ground: '+where+' role '+name+' cannot hide a sigil in quotes');}
   out.roles.push({name,value:v});continue;
  }
  if(key==='valid'&&validity){
   const [form,...rest]=words(value);assert(VALIDITY_FORMS.includes(form)&&rest.length===1,'time_form: '+where+' valid takes on|from|until "text"');
   assert(out.valid[form]===undefined,'time_form: '+where+' repeats valid '+form);out.valid[form]=text('valid '+form,rest[0]);continue;
  }
  throw Error('Unsupported field '+key+' in '+where);
 }
 // A follow-up fragment (`fragment follow_up`) carries only what the message says: the relation, the polarity
 // and all but one role may be missing; the host completes it from the conversation (DS014 Q-LANG-4).
 if(partial){assert(out.relation!==undefined||out.roles.length>=1,where+' needs a relation or a role');assert(out.roles.length<=4,where+' binds at most 4 roles');}
 else {assert(out.relation!==undefined,where+' needs relation');assert(out.roles.length>=1&&out.roles.length<=4,where+' binds 1..4 roles');assert(out.polarity!==undefined,where+' needs polarity');}
 assert(!(out.valid.on&&(out.valid.from||out.valid.until)),'time_form: '+where+' valid on excludes valid from/until');
 return out;
}
/** A query `match` block: keyword lines between `match` and `end`, parsed as a proposition with ?variables. */
export const isMatch=text=>typeof text==='string'&&/^match(\n|$)/.test(text);
export function parseMatch(text,where='match',{partial=false}={}){
 const lines=text.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
 assert(lines[0]==='match','Expected a match block');
 const pairs=lines.slice(1).map(line=>{const m=line.match(/^(\S+)(?:\s+(.*))?$/);return [m[1],m[2]??''];});
 return {kind:'match',...parseProposition(pairs,{where,variables:true,validity:false,partial,absence:true})};
}
/** Wire fields of a stated/assumed wire as proposition pairs, in written order per keyword. */
export const propositionPairs=w=>[...MATCH_KEYWORDS,'valid'].flatMap(key=>many(w,key).map(value=>[key,value]));
/** The `$id` target of a link line (`because $s2`): exactly one wire reference, nothing else (`link_form`). */
export function linkTarget(value,where='link'){const parts=words(value??'');assert(parts.length===1&&/^\$[A-Za-z][A-Za-z0-9_]*$/.test(parts[0]),'link_form: '+where+' takes exactly one $id naming a wire of this output');return parts[0].slice(1);}
/** The link lines of a wire in written keyword-table order: [{keyword, target}]. */
export const linksOf=w=>LINK_WORDS.flatMap(keyword=>many(w,keyword).map(value=>({keyword,target:linkTarget(value,'@'+w.id+' '+keyword)})));
/** `$id` role values of a stated/assumed wire or of the match blocks of a query: [{role, target}]. */
export function roleReferences(w){
 const out=[];const add=p=>{for(const r of p.roles)if(r.value&&typeof r.value==='object'&&r.value.ref)out.push({role:r.name,target:r.value.ref});};
 if(w.type==='stated'||w.type==='assumed')add(parseProposition(propositionPairs(w),{where:'@'+w.id+' '+w.type}));
 if(w.type==='query'){const partial=w.fields.fragment!==undefined;for(const text of [...many(w,'where'),...many(w,'scope')])parseCondition(text,leaf=>{if(isMatch(leaf))add(parseMatch(leaf,'@'+w.id+' match',{partial}));return leaf;});}
 return out;
}
function validateLinks(w){
 const links=linksOf(w);
 assert(links.length<=MAX_LINKS,'link_too_many: @'+w.id+' carries '+links.length+' link lines; at most '+MAX_LINKS+' per wire');
 assert(new Set(links.map(l=>l.keyword+' '+l.target)).size===links.length,'link_duplicate: @'+w.id+' repeats a link line');
 // At most one `$id` role value per wire (owner decision L1): one clause is one short proposition.
 assert(roleReferences(w).length<=1,'reference_multiple: @'+w.id+' uses more than one $id role value; split the clause into its own wire');
}
/** A compare line between two JSON-quoted operands. */
const COMPARED_LITERALS=/^\s*"(?:\\.|[^"\\])*"\s+\S+\s+"(?:\\.|[^"\\])*"\s*$/;
function validateShape(w){
 if(['stated','assumed','query'].includes(w.type))validateLinks(w);
 // A query needs `where`, except a comparison of written values only ("1 hour" above "3000 seconds"): the runtime lowers quantities
 // with units onto the memory's unit facts (sop/quantities.mjs), so such a query asks the memory without a match of its own.
 if(w.type==='query'&&!w.fields.where?.length)assert(w.fields.compare?.length&&w.fields.compare.every(line=>COMPARED_LITERALS.test(line)),'@'+w.id+' needs where');
 if(w.type==='fact')parseAtom(one(w,'holds'));
 if(w.type==='stated'||w.type==='assumed')parseProposition(propositionPairs(w),{where:'@'+w.id+' '+w.type});
 if(w.type==='stated'){
  assert(CERTAINTIES.includes(one(w,'certainty')),'@'+w.id+' certainty must be asserted, hedged or supposed');
  if(w.fields.speaker){const s=one(w,'speaker'),v=s.startsWith('"')?parseTerm(s):s;assert(s==='user'||(s.startsWith('"')&&typeof v==='string'&&v.trim()&&!/^[?$~]/.test(v)),'@'+w.id+' speaker must be user or a JSON-quoted name as written in the message');}
 }
 if(w.type==='assumed'&&w.fields.basis)assert(BASES.includes(one(w,'basis')),'@'+w.id+' basis must be one of '+BASES.join(', '));
 if(w.type==='unparsed'){
  const span=one(w,'span'),v=/^"/.test(span)?parseTerm(span):null;
  assert(typeof v==='string'&&v.trim()&&v.length<=MAX_SPAN,'unparsed_span_form: @'+w.id+' span takes one nonempty JSON-quoted verbatim part of the message (at most '+MAX_SPAN+' characters)');
  if(w.fields.near)linkTarget(one(w,'near'),'@'+w.id+' near');
  if(w.fields.hint)assert(UNPARSED_HINTS.includes(one(w,'hint')),'@'+w.id+' unparsed hint must be one of '+UNPARSED_HINTS.join(', '));
 }
 if(w.type==='pragmatic'){
  // The kinds are memory data (P-2.1, 2026-10-03): a message act the reply memory in use declares (cv_act, sop/message-acts.mjs).
  const kind=one(w,'kind');
  assert(PRAGMATIC_KIND_FORM.test(kind),'pragmatic_kind_form: @'+w.id+' pragmatic kind must be one lowercase symbol (a message act of the reply memory)');
  assert(messageActs().acts.has(kind),'pragmatic_kind_unknown: @'+w.id+' pragmatic kind must be a message act the reply memory declares (cv_act): '+messageActs().kinds.join(', '));
  assert(PRAGMATIC_BASES.includes(one(w,'basis')),'@'+w.id+' pragmatic basis must be one of '+PRAGMATIC_BASES.join(', '));
  if(w.fields.score)assert(/^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(one(w,'score')),'pragmatic_score_form: @'+w.id+' score takes a decimal from 0 to 1 with at most three digits');
  if(w.fields.source)assert(/^[a-z][a-z0-9_]*$/.test(one(w,'source')),'@'+w.id+' pragmatic source takes one strategy id (lowercase letters, digits, underscore)');
  if(w.fields.span){const span=one(w,'span'),v=/^"/.test(span)?parseTerm(span):null;assert(typeof v==='string'&&v.trim()&&v.length<=MAX_SPAN,'pragmatic_span_form: @'+w.id+' span takes one nonempty JSON-quoted verbatim part of the message (at most '+MAX_SPAN+' characters)');}
  if(w.fields.near)linkTarget(one(w,'near'),'@'+w.id+' near');
 }
 if(w.type==='instruction'){
  const action=one(w,'do'),kind=w.fields.kind?one(w,'kind'):null;
  assert(INSTRUCTION_ACTIONS.includes(action),'@'+w.id+' instruction do must be one of '+INSTRUCTION_ACTIONS.join(', '));
  if(kind!==null)assert(INSTRUCTION_KINDS.includes(kind),'@'+w.id+' instruction kind must be one of '+INSTRUCTION_KINDS.join(', '));
  if(action==='set')assert(kind!==null,'instruction_kind_required: @'+w.id+' do set names the kind of the instruction');
  if(action==='list')assert(kind===null&&!w.fields.text,'instruction_list_form: @'+w.id+' do list takes no kind and no text');
  const text=w.fields.text?parseTerm(one(w,'text')):null;
  if(w.fields.text)assert(typeof text==='string'&&text.trim()&&text.length<=MAX_SPAN,'instruction_text_form: @'+w.id+' text takes one nonempty JSON-quoted verbatim part of the message (at most '+MAX_SPAN+' characters)');
  if(action==='set')assert(INSTRUCTION_TEXT_KINDS.includes(kind)===Boolean(w.fields.text),'instruction_text: @'+w.id+' kinds '+INSTRUCTION_TEXT_KINDS.join(' and ')+' take a text, the other kinds none');
  if(w.fields.span){const span=one(w,'span'),v=/^"/.test(span)?parseTerm(span):null;assert(typeof v==='string'&&v.trim()&&v.length<=MAX_SPAN,'instruction_span_form: @'+w.id+' span takes one nonempty JSON-quoted verbatim part of the message');}
  if(w.fields.source)assert(/^[a-z][a-z0-9_]*$/.test(one(w,'source')),'@'+w.id+' instruction source takes one strategy id');
 }
 if(w.type==='unclear'){
  assert(ENUMS.unclear.kind.includes(one(w,'kind')),'@'+w.id+' unclear kind must be one of '+ENUMS.unclear.kind.join(', '));
  if(w.fields.language)assert(ENUMS.unclear.language.includes(one(w,'language')),'@'+w.id+' unclear language must be one of '+ENUMS.unclear.language.join(', '));
  // `ambiguous` lists 2..4 candidate readings, each one short JSON-quoted paraphrase; other kinds take none.
  const readings=many(w,'reading');
  if(ENUMS.unclear.readingKinds.includes(one(w,'kind'))){
   assert(readings.length>=2&&readings.length<=4,'unclear_readings: @'+w.id+' kind '+one(w,'kind')+' lists 2 to 4 reading lines');
   for(const r of readings){assert(/^"/.test(r),'@'+w.id+' reading takes one JSON-quoted paraphrase');const v=parseTerm(r);assert(typeof v==='string'&&v.trim()&&v.length<=200,'@'+w.id+' reading must be a short nonempty paraphrase');}
   assert(new Set(readings.map(r=>parseTerm(r).trim().toLowerCase())).size===readings.length,'unclear_readings: @'+w.id+' repeats a reading');
  }else assert(!readings.length,'unclear_readings: @'+w.id+' reading lines belong to kind ambiguous');
 }
 if(['rule','pattern'].includes(w.type)){many(w,'when').forEach(parseAtom);parseAtom(one(w,'then'));}
 if(w.type==='rule')assert(ENUMS.rule.mode.includes(one(w,'mode','logical')),'rule mode must be logical or causal');
 if(w.type==='hypothesis'){assert(w.fields.holds||w.fields.assume,'hypothesis requires holds or assume');if(w.fields.holds)parseAtom(one(w,'holds'));many(w,'assume').forEach(parseAtom);}
 if(w.type==='goal')many(w,'where').forEach(parseAtom);
 if(w.type==='trace')many(w,'feature').forEach(parseAtom);
 if(w.type==='action'){for(const key of ['requires','adds','removes'])many(w,key).forEach(parseAtom);assert(w.fields.adds||w.fields.removes,'action needs effects');}
 if(['abduce','diagnose','associate','induce','analogize','plan','simulate','temporal'].includes(w.type))outputSpecs(w);
 if(w.type==='query'){
  const partial=w.fields.fragment!==undefined;
  if(partial)assert(ENUMS.query.fragment.includes(one(w,'fragment')),'@'+w.id+' fragment must be one of '+ENUMS.query.fragment.join(', '));
  const leaf=leaf=>isMatch(leaf)?parseMatch(leaf,'@'+w.id+' match',{partial}):parseAtom(leaf,{absence:true});
  many(w,'where').forEach(s=>parseCondition(s,leaf));if(w.fields.scope)parseCondition(one(w,'scope'),leaf);
  many(w,'filter').forEach(parseBooleanCondition);assert(['at','during','overlaps'].filter(k=>w.fields[k]).length<2,'Use at OR during OR overlaps');
  const mode=one(w,'mode');if(mode!==undefined)assert(ENUMS.query.mode.includes(mode),'@'+w.id+' query mode must be one of '+ENUMS.query.mode.join(', '));
  // A universal question: `where` is the restriction (the domain), `scope` what must hold for each member.
  assert(!w.fields.scope===(mode!=='every'),mode==='every'?'every_needs_scope: @'+w.id+' mode every needs a scope block':'scope_needs_every: @'+w.id+' scope belongs to mode every');
  if(w.fields.measure){assert(ENUMS.query.measure.includes(one(w,'measure')),'@'+w.id+' measure must be one of '+ENUMS.query.measure.join(', '));assert(words(one(w,'select','')).length===1&&(mode??'select')==='select','measure_needs_time_variable: @'+w.id+' measure applies to exactly one selected time variable in mode select');}
  if(w.fields.span)assert(/^\?[A-Za-z][A-Za-z0-9_]*$/.test(one(w,'span')),'@'+w.id+' span takes one ?variable');
  if(mode==='explain')assert(!w.fields.select,'explain_no_select: @'+w.id+' mode explain asks why a proposition holds; it selects nothing');
  validateWordFields(w,mode);
 }
 if(w.type==='jsEval')parseExpression(one(w,'expr'));
 // A computation ("what is 19% of 2380?") selects its result and needs no claim; every other constraint states one.
 if(w.type==='constraint'){assert(w.fields.claim||w.fields.select,'@'+w.id+' needs claim (or select for a computation)');for(const key of ['task','direction'])if(w.fields[key])assert(ENUMS.constraint[key].includes(one(w,key)),'@'+w.id+' constraint '+key+' must be one of '+ENUMS.constraint[key].join(', '));many(w,'require').forEach(parseBooleanCondition);if(w.fields.claim)parseBooleanCondition(one(w,'claim'));}
 if(w.type==='value'){const a=parseExpression(one(w,'data'));assert(a.type!=='name','value needs a literal or expression');}
 if(w.type==='event')assert(ENUMS.event.action.includes(one(w,'action')),'Unknown event action');
 if(w.type==='resolve'){assert(ENUMS.resolve.kind.includes(one(w,'kind')),'resolve kind must be entity or predicate');assert(/^[a-z]{2,3}$/.test(one(w,'language')),'resolve needs an explicit language');assert(!w.fields.type||one(w,'kind')==='entity','resolve type is only for entities');for(const key of ['text','type','domain'])if(w.fields[key])assert(typeof unquote(one(w,key))==='string'&&unquote(one(w,key)).length>0,'resolve '+key+' must be nonempty text');}
 if(w.type==='solve'){outputSpecs(w);assert(!(w.fields.constraint&&(w.fields.data||w.fields.assume)),'Constraint solve cannot consume undeclared fact data');}
 if(w.type==='reason'||w.type==='solve')assert(!!w.fields.query!==!!w.fields.constraint,'reason needs exactly query OR constraint');
}
const VARIABLE=/^\?[A-Za-z][A-Za-z0-9_]*$/;
const OPERAND=/^(?:\?[A-Za-z][A-Za-z0-9_]*|-?\d+|"(?:\\.|[^"\\])*")$/;
/**
 * The words-only query fields (DS014 "Words, not operators"): `compare ?v above 80`, `except ?x "Ana"`,
 * `rank highest ?v`, `quantifier most` (mode every), `order ?t1 before ?t2` (the host appends `leaves I J`).
 */
function validateWordFields(w,mode){
 // `compare` is one comparison, or an all/any/end group of them ("BT or UniCredit": compare any … end).
 // The left side is a variable, or a JSON-quoted quantity with a unit ("1 hour" above "3000 seconds", lowered by sop/quantities.mjs).
 const compareLeaf=line=>{const [left,cmp,right,...rest]=words(line);assert((VARIABLE.test(left??'')||/^"/.test(left??''))&&OPERAND.test(left??'')&&Object.hasOwn(COMPARATOR_WORDS,cmp??'')&&OPERAND.test(right??'')&&!rest.length,'compare_form: @'+w.id+' compare takes ?variable COMPARATOR value (or two quoted quantities with units), COMPARATOR one of '+Object.keys(COMPARATOR_WORDS).join(', '));return {left,op:cmp,right};};
 for(const text of many(w,'compare'))parseCondition(text,leaf=>{assert(!isMatch(leaf),'compare_form: @'+w.id+' compare holds comparisons, not match blocks');return compareLeaf(leaf);});
 for(const line of many(w,'except')){const [variableName,value,...rest]=words(line);assert(VARIABLE.test(variableName??'')&&OPERAND.test(value??'')&&!rest.length,'except_form: @'+w.id+' except takes ?variable "value"');}
 if(w.fields.rank){const [direction,variableName,...rest]=words(one(w,'rank'));assert(RANK_WORDS.includes(direction)&&VARIABLE.test(variableName??'')&&(!rest.length||(rest.length===2&&RANK_CUTS.includes(rest[0])&&/^[1-9]\d{0,2}$/.test(rest[1]))),'rank_form: @'+w.id+' rank takes highest|lowest ?variable, optionally followed by position N or top N');}
 if(w.fields.quantifier){
  assert(mode==='every','quantifier_needs_every: @'+w.id+' quantifier belongs to mode every');
  const [word,count,...rest]=words(one(w,'quantifier'));
  assert(QUANTIFIER_WORDS.includes(word)&&!rest.length,'quantifier_form: @'+w.id+' quantifier is one of '+QUANTIFIER_WORDS.join(', '));
  assert(word==='at_least'?/^[1-9]\d*$/.test(count??''):count===undefined,'quantifier_form: @'+w.id+' at_least takes a positive integer; the other quantifiers take none');
 }
 // `order random` (one word, ORDER_SAMPLING): a seeded random order of the answers, a random sample with `limit` (mode select only).
 if(w.fields.order&&words(one(w,'order')).length===1){const [word]=words(one(w,'order'));assert(ORDER_SAMPLING.includes(word),'order_form: @'+w.id+' order takes ?time1 before|after|same_time ?time2, or the single word '+ORDER_SAMPLING.join('|'));assert(ORDER_SAMPLING_MODES.includes(mode??'select'),'order_random_mode: @'+w.id+' order random samples the answers of mode '+ORDER_SAMPLING_MODES.join('|')+', not mode '+mode);}
 else if(w.fields.order){
  const parts=words(one(w,'order'));
  assert((parts.length===3||(parts.length===6&&parts[3]==='leaves'&&/^\d+$/.test(parts[4])&&/^\d+$/.test(parts[5])))&&VARIABLE.test(parts[0])&&ORDER_WORDS.includes(parts[1])&&VARIABLE.test(parts[2])&&parts[0]!==parts[2],'order_form: @'+w.id+' order takes ?time1 before|after|same_time ?time2');
 }
}
export function validateGraph(program,{allowMaterialized=false}={}) {
 const outputs=outputRegistry(program,{allowMaterialized}),ids=new Set(program.wires.map(w=>w.id)),deps=new Map();
 for(const name of outputs.keys())ids.add(name);
 for(const w of program.wires){const d=dependencies(w);for(const id of [...d.values,...d.handles])assert(ids.has(id),'Unknown reference '+id+' in @'+w.id);deps.set(w.id,d.values);}
 for(const [name,spec]of outputs)if(!deps.has(name))deps.set(name,[spec.owner]);
 const done=new Set(),order=[];
 while(done.size<ids.size){const ready=[...ids].filter(id=>!done.has(id)&&deps.get(id).every(x=>done.has(x)));assert(ready.length,'Cyclic value dependencies (including deferred outputs)');for(const id of ready){done.add(id);order.push(id);}}
 return order;
}
export function canonical(program){return program.wires.map(w=>'@'+w.id+' '+w.type+'\n'+Object.entries(w.fields).flatMap(([k,vs])=>vs.map(v=>conditionField(w.type,k)&&/^(all|any|match)\n/.test(v)?'  '+k+' '+formatCondition(v):v.includes('\n')?'  '+k+' |\n'+v.split('\n').map(l=>'    '+l).join('\n'):'  '+k+(v?' '+v:''))).join('\n')).join('\n\n')+'\n';}
export function replaceReferences(source,names){let out='',quoted=false,esc=false;for(let i=0;i<source.length;i++){const c=source[i];if(quoted){out+=c;if(!esc&&c==='"')quoted=false;if(!esc&&c==='\\')esc=true;else esc=false;continue;}if(c==='"'){quoted=true;out+=c;continue;}if(c==='$'||c==='~'){const m=source.slice(i+1).match(/^[A-Za-z][A-Za-z0-9_]*/);if(m){out+=c+(names[m[0]]??m[0]);i+=m[0].length;continue;}}out+=c;}return out;}
