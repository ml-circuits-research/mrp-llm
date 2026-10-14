/** Import reviewed declarative SOP. No code from a document is executed here. */
import {LIBRARY_TYPES,DECLARATIONS,lowerDeclaration} from '../reasoning/lower.mjs';
import {parse,canonical,dependencies} from './parser.mjs';
import {lowerFact,lowerRule} from './lower.mjs';
import {createLayer,knowledgeConfig} from '../memory/factory.mjs';
import {assert,digest} from '../lib/util.mjs';
export function prepareKnowledge(source,{schema=null,memory={},knownAt=Date.now(),documents={},requireQuotes=false,reviewed=false}={}){
 assert(reviewed,'Knowledge publication requires explicit reviewed approval');const p=parse(source),layer=createLayer(knowledgeConfig(memory)),library=[];
 for(const w of p.wires){assert(w.type==='fact'||LIBRARY_TYPES.has(w.type),'Ingestion accepts fact/rule/template definitions, not executable effects');assert(!dependencies(w).values.length,'Persisted definitions cannot depend on ephemeral wires');const sop=canonical({wires:[w]});
  if(w.type==='fact'){const f=lowerFact(w,{},schema);if(requireQuotes){const doc=documents[f.source];assert(typeof doc==='string','Unknown fact source '+f.source);assert(f.quote&&doc.includes(f.quote),'Quote is not an exact source span');}layer.add(f,{knownAt,sourceSOP:sop});}
  else {if(w.type==='rule')lowerRule(w,{},schema);else if(DECLARATIONS.has(w.type))lowerDeclaration(w,{},schema);else {const child=parse(w.fields.body[0]);assert(child.wires.length<512,'Template body too large');}library.push({kind:'library',id:w.id,wireType:w.type,sop,hash:digest(sop),knownAt});}
 }
 return {layer,library,definitions:p.wires.length};
}
export function publishKnowledge(repo,base,source,options){const prepared=prepareKnowledge(source,{memory:repo.memory,...options});const snapshot=repo.publish(base,prepared.layer,prepared.library);return {...prepared,snapshot};}
