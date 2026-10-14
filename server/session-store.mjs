import fs from 'node:fs';
import path from 'node:path';
import {digest,checkName} from '../lib/util.mjs';
import {Agent} from './agent.mjs';

export class SessionStore {
 constructor({repo,lexicon,config,root,circuitRules=null}) { Object.assign(this,{repo,lexicon,config,circuitRules,root:path.resolve(root)});this.agents=new Map();fs.mkdirSync(this.root,{recursive:true,mode:0o700}); }
 /** Replaces the lexicon of the store and of the agents already opened (circuits accepted into the session). */
 setLexicon(lexicon){this.lexicon=lexicon;for(const {agent} of this.agents.values())agent.lexicon=lexicon;}
 get(user,conversation,base) {
  checkName(user);checkName(conversation);checkName(base);
  const key=digest([base,user,conversation]);
  if(this.agents.has(key))return this.agents.get(key);
  const file=path.join(this.root,key+'.json');
  const agent=new Agent({repo:this.repo,session:this.repo.session(base,user,conversation),lexicon:this.lexicon,config:this.config,circuitRules:this.circuitRules});
  if(fs.existsSync(file)){
   const state=JSON.parse(fs.readFileSync(file,'utf8'),(key,value)=>['from','until'].includes(key)?value==='__ChatSOP_INFINITY__'?Infinity:value==='__ChatSOP_NEG_INFINITY__'?-Infinity:value:value);
   if(state.version!==1||state.user!==user||state.conversation!==conversation||state.base!==base)throw Error('Conversation state mismatch');
   agent.recent=state.recent;agent.last=state.last;agent.context={statements:state.context?.statements??[],...(state.context?.behaviour?{behaviour:state.context.behaviour}:{})};
  }
  const entry={agent,file,key};this.agents.set(key,entry);return entry;
 }
 save({agent,file},user,conversation,base) {
  const temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify({version:1,user,conversation,base,recent:agent.recent,last:agent.last,context:agent.context},(key,value)=>['from','until'].includes(key)?value===Infinity?'__ChatSOP_INFINITY__':value===-Infinity?'__ChatSOP_NEG_INFINITY__':value:value),{mode:0o600});
  fs.renameSync(temp,file);
 }
}
