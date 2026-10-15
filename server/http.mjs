#!/usr/bin/env node
import '../lib/env-aliases.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {Repository} from '../memory/repository.mjs';
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import {Runtime} from '../sop/runtime.mjs';
import {parse} from '../sop/parser.mjs';
import {SessionStore} from './session-store.mjs';
import {Auth,sessionCookie,readCookie} from './auth.mjs';
import {handleWeb,createSignedInRoutes} from './web.mjs';
import {sendHtml} from './pages/layout.mjs';
import {adminPage} from './pages/admin.mjs';
import {chatPage} from './pages/chat.mjs';
import {createCapabilities} from './capabilities.mjs';
import {createApiRouter} from './api.mjs';
import {createProductRouter,PRODUCT_ENDPOINTS} from './product.mjs';
import {BaseMemories,ensureDefaultBase} from '../lib/chat-data/memories.mjs';
import {ensureSeedMemories,seedIsCurrent} from '../lib/knowledge-seeds.mjs';
import {setReplyLayer,CONVERSATION_LAYER} from '../sop/replies.mjs';
import {conversationCircuits,ensureReplyMemory} from '../lib/chat-data/composer.mjs';
import {warmMemories} from './warm-memories.mjs';
import {ChatData} from '../lib/chat-data/index.mjs';
import {Sessions} from '../lib/chat-data/sessions.mjs';
import {SessionRuntimes} from './session-runtime.mjs';
import {createAuthoring,AUTHORING_ENDPOINTS} from './authoring.mjs';
import {createKnowledgeRouter,KNOWLEDGE_ENDPOINTS} from './review.mjs';
import {createFeedback,FEEDBACK_ENDPOINTS} from './feedback.mjs';
import {createAnalysisRoutes,ANALYSIS_ENDPOINTS} from './analysis.mjs';
import {createQueryParser,queryParserSettings} from './query-parser.mjs';
import {serverStatus} from './status.mjs';
import {createAnswerFormulator,answerLanguageSettings} from './answer-language.mjs';
import {createChatSOPAdapter,checkAdapterOptions} from '../lib/adapter/index.mjs';
import {chatTurn} from '../lib/adapter/chat-turn.mjs';
import {Models,checkSlots} from '../lib/mrp/models.mjs';
import {createMrpPipeline} from '../lib/mrp/pipeline.mjs';
import {createMrpRoutes,MRP_ENDPOINTS,writeToBase} from './mrp-routes.mjs';
import {configureStrategyService} from '../lib/mrp/strategy-service.mjs';
import {retrieveCandidates} from '../lib/mrp/retrieve.mjs';
import {modelsPage} from './pages/models.mjs';

/** `GET /v1/status` (server/status.mjs): the formalization strategies, base memories, engines and caches of this server. */
export const STATUS_ENDPOINT=Object.freeze({method:'GET',path:'/v1/status',capability:'status'});

const root=fileURLToPath(new URL('../',import.meta.url));
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const error=(res,status,code,message)=>json(res,status,{error:{message,type:'invalid_request_error',code}});
const positive=(value,name)=>{if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid server limit: '+name);return value;};
const credentials=(tokens)=>{const entries=Object.entries(tokens);
 if(!entries.length)throw Error('No bearer credentials configured. Set CHATSOP_API_KEY (at least 16 characters), or start with `npm start` which generates a token for you.');
 const bad=entries.find(([user,token])=>! /^[A-Za-z0-9_-]{1,80}$/.test(user)||typeof token!=='string');
 if(bad)throw Error('Bearer credentials map a user name (letters, digits, _ or -) to a token; invalid entry for user '+JSON.stringify(bad[0]));
 const short=entries.find(([,token])=>token.length<16);
 if(short)throw Error('Bearer token for user '+JSON.stringify(short[0])+' is '+JSON.stringify(short[1]).length+' characters; tokens must be at least 16 characters');
 if(new Set(entries.map(x=>x[1])).size!==entries.length)throw Error('Bearer tokens must be unique per user');
 return entries;};
const authenticate=(header,users)=>{if(typeof header!=='string'||!header.startsWith('Bearer '))return null;const supplied=Buffer.from(header.slice(7));let user=null;for(const [name,key] of users){const expected=Buffer.from(key);if(supplied.length===expected.length&&timingSafeEqual(supplied,expected))user=name;}return user;};
async function readBody(req,maxBytes){let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>maxBytes){req.resume();const e=new Error('Request body exceeds configured limit');e.status=413;throw e;}chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{const e=new Error('Expected a JSON request body');e.status=400;throw e;}}
const invalid=(message,code='invalid_request')=>Object.assign(new Error(message),{status:400,code});
/** Validates a chat completion request; `models` is the set of accepted `model` values (the façade id). */
function checkBody(body,models,maxContextBytes){if(!body||typeof body!=='object'||Array.isArray(body))throw invalid('Expected a chat completion object');if(typeof body.model!=='string'||!models.has(body.model))throw invalid('Unknown model '+JSON.stringify(String(body.model).slice(0,80))+'; GET /v1/models lists the available models: '+[...models].join(', '),'unknown_model');if(body.tools!==undefined||body.tool_choice!==undefined||body.functions!==undefined||body.function_call!==undefined)throw invalid('Tools and function calling are not implemented');if(![undefined,false,true].includes(body.stream))throw invalid('stream must be a boolean');if(!Array.isArray(body.messages)||body.messages.length!==1||body.messages[0]?.role!=='user'||typeof body.messages[0].content!=='string'||!body.messages[0].content.trim()||Object.keys(body.messages[0]).some(k=>!['role','content'].includes(k)))throw invalid('Supply exactly one new user text message; conversation history is server-managed');if(Buffer.byteLength(body.messages[0].content)>maxContextBytes) {const e=new Error('Message exceeds context limit');e.status=413;throw e;}const allowed=new Set(['model','messages','stream','user','conversation_id','session_id','chatSop','adapter','metadata']);if(body.metadata!==undefined&&(typeof body.metadata!=='object'||!body.metadata||Array.isArray(body.metadata)))throw invalid('metadata must be an object');if(Object.keys(body).some(k=>!allowed.has(k)))throw invalid('Unsupported chat completion parameter');if(body.chatSop!==undefined&&(typeof body.chatSop!=='object'||!body.chatSop||Array.isArray(body.chatSop)||Object.keys(body.chatSop).some(k=>k!=='trustedSop')||typeof body.chatSop.trustedSop!=='string'))throw invalid('Invalid chatSop trusted circuit');return body.messages[0].content;}
function checkedTrusted(source){const wires=parse(source).wires;if(!wires.length||!wires.some(w=>w.type==='remember')||wires.some(w=>!['fact','event','remember'].includes(w.type)))throw Error('Trusted circuit requires an explicit remember of facts or events');return source;}
const docsRoot=path.join(root,'docs');
const mimeTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.woff2':'font/woff2','.map':'application/json'};
function serveDocs(res,url){
 let relative;try{relative=decodeURIComponent(url.slice('/docs/'.length));}catch{return error(res,400,'invalid_path','Malformed static path');}
 if(relative.includes('\0'))return error(res,400,'invalid_path','Unsafe static path');
 const target=path.resolve(docsRoot,relative);
 if(target!==docsRoot&&!target.startsWith(docsRoot+path.sep))return error(res,400,'invalid_path','Unsafe static path');
 const resolved=fs.statSync(target,{throwIfNoEntry:false})?.isDirectory()?path.join(target,'index.html'):target;
 const stat=fs.statSync(resolved,{throwIfNoEntry:false});
 if(!stat||!stat.isFile())return error(res,404,'not_found','Static file not found');
 const body=fs.readFileSync(resolved),extension=path.extname(resolved).toLowerCase();
 res.writeHead(200,{'Content-Type':mimeTypes[extension]??'application/octet-stream','Content-Length':body.length,'Cache-Control':extension==='.html'?'no-cache':'max-age=300'});
 res.end(body);
}
/** Repository Markdown served read-only at its repository path (GET, signed-in): skills, READMEs and the root notes. */
export const REPO_MARKDOWN=/^\/(?:skills\/(?:README\.md|[A-Za-z0-9-]+\/SKILL\.md)|eval\/README\.md|(?:README|AGENTS|TODO|CHANGES|questions|dependencies)\.md)$/;
function serveRepoMarkdown(res,url){
 const file=path.join(root,url.slice(1));
 const stat=fs.statSync(file,{throwIfNoEntry:false});
 if(!stat||!stat.isFile())return error(res,404,'not_found','File not found');
 const body=fs.readFileSync(file);
 res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
 res.end(body);
}
const bearerToken=header=>{const match=/^Bearer\s+(.+)$/.exec(String(header??''));return match?match[1].trim():null;};
const readJsonBody=async(req,limit=1_000_000)=>{let raw='';for await(const chunk of req)raw+=chunk;assertBody(raw.length<=limit,'Request body exceeds the admin limit');return raw?JSON.parse(raw):{};};
const assertBody=(condition,message)=>{if(!condition){const e=new Error(message);e.status=413;throw e;}};

async function handleAdmin(req,res,url,auth,readiness){
 try{
  return await adminRoutes(req,res,url,auth,readiness);
 }catch(e){
  const status=e.status??(e.code==='invalid_credentials'?401:400);
  return error(res,status,e.code??'invalid_request',e.message);
 }
}
async function adminRoutes(req,res,url,auth,readiness){
 const method=req.method;
 if(method==='GET'&&url==='/admin'){
  return sendHtml(res,200,adminPage({signedIn:Boolean(auth.session(readCookie(req.headers.cookie,'chatsop_session')))}));
 }
 if(method==='GET'&&url==='/admin/status'){
  const state=await readiness();
  const session=auth.session(readCookie(req.headers.cookie,'chatsop_session'));
  return json(res,200,{configured:auth.configured,authenticated:Boolean(session),ready:state.ready,model_available:state.model_available===true,tokens:auth.configured&&session?auth.tokens():undefined});
 }
 if(method==='POST'&&url==='/admin/setup'){
  const body=await readJsonBody(req);
  const token=auth.setup(body.password);
  res.setHeader('Set-Cookie',sessionCookie(token));
  return json(res,200,{configured:true,authenticated:true});
 }
 if(method==='POST'&&url==='/admin/login'){
  const body=await readJsonBody(req);
  const token=auth.login(body.password);
  if(!token){const failure=new Error('Wrong administrator password');failure.code='invalid_credentials';throw failure;}
  res.setHeader('Set-Cookie',sessionCookie(token));
  return json(res,200,{authenticated:true});
 }
 if(method==='POST'&&url==='/admin/logout'){
  auth.logout(readCookie(req.headers.cookie,'chatsop_session'));
  res.setHeader('Set-Cookie','chatsop_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return json(res,200,{authenticated:false});
 }
 const session=auth.session(readCookie(req.headers.cookie,'chatsop_session'));
 if(!session)return error(res,401,'unauthorized','Sign in on /login first');
 if(method==='POST'&&url==='/admin/token'){
  const body=await readJsonBody(req);
  return json(res,200,auth.mintToken(body.label));
 }
 if(method==='POST'&&url==='/admin/token/revoke'){
  const body=await readJsonBody(req);
  return json(res,200,{revoked:auth.revoke(body.id)});
 }
 return error(res,404,'not_found','Endpoint not found');
}

function trace(result,formalizer,system,parse=null){const packet=result.packet??{};const p=parse??packet.parse??null;return {mode:'formalize',adapter:packet.adapter??null,parse:p,english_text:result.englishText??null,answer_language:result.answerLanguage??null,strategy:p?.strategy??null,session_circuits:packet.session_circuits??null,verification:packet.route?.verification??null,latency_ms:result.formalization?.ms??null,formalizer_label:formalizer.label??null,formalization_ms:result.formalization?.ms??null,circuit:result.executionSop,model_sop:result.sop,provenance:packet.proof??[],backend:packet.route?.backend??packet.backend??null,fallback:packet.route?.fallback??packet.fallback??null,completeness:packet.complete??packet.completeness??null,retrieval:packet.retrieval??null,route:packet.route??null,reasoning_strategy:packet.reasoningStrategy??null,cnl:result.cnl,status:packet.status??null,pendingSop:packet.pendingSop??null,required:packet.required??null,reinforcement:packet.reinforcement??null,user_statements:result.userStatements??[],carried_statements:result.carriedStatements??[],model_assumptions:result.modelAssumptions??[],assumption_policy:result.assumptionPolicy??null,assumption_branch:result.assumptionBranch??null,unclear:result.unclear??null,pragmatic:packet.pragmatic??null,reply:packet.reply??null,near_miss:packet.near_miss??null,behaviour:packet.behaviour??null,instructions:packet.instructions??null,understood_as:packet.understood_as??null,linking:packet.linking??[],system_circuit:system?.source??null,system_receipt:system?.receipt??null,formalizer_model:result.formalization?.model??formalizer.id??formalizer.model};}
function completion(result,model,formalizer,system,parse=null,traceId=null){const id=traceId??'chatcmpl-'+randomUUID(),created=Math.floor(Date.now()/1000);return {id,object:'chat.completion',created,model,choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:'stop'}],usage:null,chatSop:trace(result,formalizer,system,parse)};}
function sse(res,data){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});const base={id:data.id,created:data.created,model:data.model,object:'chat.completion.chunk'};res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:data.choices[0].message.content},finish_reason:null}],chatSop:data.chatSop})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}
/**
 * The HTTP server. With `chatData` (what `startServer` always passes) chats run in sessions on base memories (DS022). Without it the server runs in
 * single-repository mode: one repository and one lexicon, conversations kept by `SessionStore`; embedders and the tests that do not exercise the
 * product layer use it. The request parser (server/query-parser.mjs, the coding agent) is created from `config.queryParser` unless `queryParser` is injected (tests).
 */
export function createServer({config,repo,lexicon,authTokens,auth=null,base='demo',limits={},sessionRoot,chatData=null,queryParser:injected=null,answerFormulator:injectedFormulator,authorChat=null,feedback:feedbackOptions={},adapter:injectedAdapter=null}={}){
 if(!config||!repo||!lexicon)throw Error('Server requires config, repository and lexicon');
 const model=config.model??'chatsop-local';
 const users=auth?null:credentials(authTokens??(process.env.CHATSOP_API_KEY?{local:process.env.CHATSOP_API_KEY}:{}));
 const maxRequestBytes=positive(limits.maxRequestBytes??65536,'maxRequestBytes'),maxContextBytes=positive(limits.maxContextBytes??4800,'maxContextBytes'),maxConcurrent=positive(limits.maxConcurrent??4,'maxConcurrent'),timeoutMs=positive(limits.timeoutMs??180000,'timeoutMs');  // 3 min: a turn may run repair rounds and the vocabulary dialog over a model chain (queryParser.timeoutSeconds per model)
 const sessions=new SessionStore({repo,lexicon,config:{...config,contextMaxBytes:Math.min(config.contextMaxBytes??maxContextBytes,maxContextBytes)},root:sessionRoot??path.join(repo.root,'http-conversations')});
 const pages=createSignedInRoutes();
 let active=0;const busy=new Set();
 const accepted=new Set([model]);let mrpModels=null;const acceptedModels={has:id=>accepted.has(id)||Boolean(mrpModels?.exists(id)),[Symbol.iterator]:function*(){yield* accepted;if(mrpModels)yield* mrpModels.ids();}};
 // The request parser (DS009 "Request parser"): the step-by-step formalizer asks its questions to the tier ladder through the
 // Ploinky proxy; no path runs omp and no model writes a whole circuit (owner 2026-10-02).
 const queryParser=injected??createQueryParser({settings:queryParserSettings(config),chatData});
 // Answer formulation in the user's language (server/answer-language.mjs); a server with an injected request parser (tests) has none unless one is injected too.
 const answerFormulator=injectedFormulator!==undefined?injectedFormulator:injected?null:createAnswerFormulator({settings:answerLanguageSettings(config)});
 // ChatSOPAdapter (lib/adapter): the one backend of the chat, the API and every evaluation; its mode comes from config.adapter.mode, the
 // session setting adapter_mode or the request's `adapter: {mode, options}`.
 const adapter=injectedAdapter??createChatSOPAdapter({config});
 const capabilities=createCapabilities({queryParser});
 const api=createApiRouter({capabilities,json,extraEndpoints:[STATUS_ENDPOINT,...(chatData?[...MRP_ENDPOINTS,...PRODUCT_ENDPOINTS,...AUTHORING_ENDPOINTS,...KNOWLEDGE_ENDPOINTS,...FEEDBACK_ENDPOINTS,...ANALYSIS_ENDPOINTS]:[])]});
 const startedAt=Date.now();
 // The product layer (DS022): base memories, sessions, knowledge authoring. Present when a chat data root is configured (startServer always does).
 const memories=chatData?new BaseMemories({chatData,memory:config.memory}):null;
 const defaultBase=memories?ensureDefaultBase(memories,config):null;
 // The conversation layer (DS023 "Conversation layer"): the reply wires and rules of the stored seed memory conversation-v1 (reviewed in
 // /review); the shipped copy (config/knowledge/conversation-v1) is the layer of a server without chat data. A stale stored copy is reported.
 // The reply memory (config conversation.memory, DS022 "Composing a base memory") is conversation-v1 plus the chosen small-talk
 // collections; it is composed from conversation.layers when missing, and its conversation layers are the reply layer.
 let replyMemory=null;
 const loadReplyLayer=id=>{const circuits=conversationCircuits(memories,id);setReplyLayer(circuits,'base memory '+id);return {memory:id,circuits:circuits.length};};
 if(memories){try{ensureSeedMemories(memories,{strategy:config.memory?.engine});const reply=ensureReplyMemory(memories,config);replyMemory=reply.id;if(replyMemory){loadReplyLayer(replyMemory);for(const l of reply.stale)console.warn('conversation layer: '+l+(replyMemory===l?'':' in '+replyMemory)+' differs from config/knowledge/'+l+'; renew it with node tools/refresh-seed-memories.mjs --only '+l+' --apply'+(replyMemory===l?'':' (then '+replyMemory+' is composed again at the next start, or rebuild it on /admin)'));}}catch(e){console.error('conversation layer: '+e.message);throw e;}}
 // MRP-LLM models (lib/mrp/models.mjs, DS025): a model is a base memory plus one strategy per pipeline slot; the shipped profiles marked
 // createOnFirstStart become models when none exists. The default model answers requests that name no model. The layer is on when the
 // configuration has an `mrp` section (the shipped config/runtime.json); without it the server runs the bare symbolic core.
 mrpModels=config.mrp&&memories&&(chatData.modelsDir??chatData.root??chatData.baseMemoriesDir)?new Models({root:chatData.modelsDir??path.join(chatData.root??path.dirname(chatData.baseMemoriesDir),'models'),memories}):null;
 if(mrpModels){try{const made=mrpModels.ensureDefaults();if(made.length)console.log('models created from profiles: '+made.join(', '));}catch(e){console.error('creating the default models failed: '+e.message);}}
 const defaultModel=mrpModels?(mrpModels.exists(config.mrp?.defaultModel)?config.mrp.defaultModel:mrpModels.ids()[0]??null):null;
 configureStrategyService(config.mrp?.strategyService?.url??null);
 const mrp=mrpModels?createMrpPipeline({models:mrpModels,extraBody:config.mrp?.extraBody??null,...(config.mrp?.client?{client:config.mrp.client}:{})}):null;
 const mrpRoutes=mrpModels?createMrpRoutes({models:mrpModels,memories,readBody,json,...(config.mrp?.client?{client:config.mrp.client}:{})}):null;
 const sessionStore=chatData?new Sessions({chatData,memories,memory:config.memory}):null;
 const runtimes=chatData?new SessionRuntimes({sessions:sessionStore,memories,config:{...config,contextMaxBytes:Math.min(config.contextMaxBytes??maxContextBytes,maxContextBytes)},defaultBase}):null;
 const authoring=chatData?createAuthoring({sessions:sessionStore,runtimes,chatData,formalizer:queryParser.settings??null,settings:{model:config.ingest?.tier??'small'},chat:authorChat,readBody,json,maxBytes:limits.maxProductBytes??8_000_000}):null;
 // Chat feedback (server/feedback.mjs, DS022 "Chat feedback"): votes on answered turns, routed by cause. `feedback.dir`/`feedback.inbox` move the files (tests).
 const feedback=chatData?createFeedback({sessions:sessionStore,readBody,json,gapsFile:path.join(chatData.root,'query-gaps.jsonl'),onVote:(turn,row)=>{if(turn?.reflex&&mrpModels?.exists(turn.model))mrpModels.reflexFeedback(turn.model,{score:turn.reflex.score,helpful:row.vote==='up'});},...feedbackOptions}):null;
 // Analysis procedures over a session or a base memory (server/analysis.mjs, DS022 "Analysis procedures"): read only, no model.
 const analysis=chatData?createAnalysisRoutes({memories,sessions:sessionStore,readBody,json,maxBytes:limits.maxProductBytes??8_000_000}):null;
 const product=chatData?createProductRouter({memories,sessions:sessionStore,runtimes,readBody,json,limits,extra:{actions:{...authoring.actions,...feedback.actions,...analysis.actions},routes:[...authoring.routes,...feedback.routes,...analysis.routes]},parsing:{queryParser},defaultBase,modelBaseOf:id=>mrpModels?.exists(id)?mrpModels.get(id).base:null,checkMrpSettings:settings=>{if(!mrpModels)return;if(settings.model!=null&&!mrpModels.exists(settings.model))throw Object.assign(new Error('Unknown model '+JSON.stringify(settings.model)+'; GET /v1/models lists the models'),{status:400,code:'unknown_model'});if(settings.slots!=null)checkSlots(settings.slots);},commitGuard:info=>{const id=info.settings?.model;if(id&&mrpModels?.exists(id)&&mrpModels.effective(id).slots.commit.strategy==='never')throw Object.assign(new Error('The model '+id+' never commits session knowledge (commit strategy never)'),{status:403,code:'commit_refused'});},composer:{replyMemory:()=>replyMemory,onComposed:m=>m.id===replyMemory?loadReplyLayer(m.id):null}}):null;
 // The knowledge browser (/review, GET /v1/knowledge/*): read only, over a base memory or a chat session (server/review.mjs); without a chat data root the API answers 501.
 const knowledge=createKnowledgeRouter({memories,sessions:sessionStore,json});
 /** Whether the coding agent can run now, with the model chain; the chat answers 503 `parse_unavailable` when it cannot. */
 async function readiness(){
  const free=await queryParser.availability();
  return {ready:free.available===true,model_available:free.available===true,default_model:model,formalizer:{strategy:queryParser.defaultStrategy??queryParser.settings?.strategy??'LocalLLMStepByStep',available:free.available===true,...(free.reason?{reason:free.reason}:{}),models:queryParser.settings?.models??[],...(free.skipped?.length?{skipped:free.skipped}:{})}};
 }
 const server=http.createServer(async(req,res)=>{
  const url=req.url?.split('?')[0];if((url==='/healthz'||url==='/health')&&req.method==='GET')return json(res,200,{status:'ok'});
  // The documentation site is served statically and needs no authentication:
  // it is the same public HTML that lives under docs/ in the repository.
  if(req.method==='GET'&&url==='/docs'){res.writeHead(302,{Location:'/docs/'});return res.end();}
  if(req.method==='GET'&&url?.startsWith('/docs/'))return serveDocs(res,url);
  // Browser pages: home, /login, /logout and the login redirect of signed-out
  // page loads. They present the session-cookie auth; they never grant access.
  try{if(await handleWeb(req,res,url,{auth,readiness}))return;}catch(e){if(res.headersSent)return res.end();return error(res,e.status??400,e.code??'invalid_request',e.message);}
  if(auth&&(url==='/admin'||url?.startsWith('/admin/')))return await handleAdmin(req,res,url,auth,readiness);
  const sessionUser=auth?auth.session(readCookie(req.headers.cookie,'chatsop_session')):null;
  const bearer=auth?auth.bearer(bearerToken(req.headers.authorization)):null;
  const legacy=users?authenticate(req.headers.authorization,users):null;
  const user=sessionUser??bearer??legacy;
  if(!user){
   if(auth&&!auth.usable)return error(res,403,'setup_required','Open /login in a browser and set the administrator password to enable this API');
   return error(res,401,'unauthorized','Bearer authentication required');
  }
  // Repository Markdown that the documentation links to (skills, the eval README, root notes),
  // served read-only as plain text to signed-in users so the server carries all documentation.
  if(req.method==='GET'&&REPO_MARKDOWN.test(url??''))return serveRepoMarkdown(res,url);
  try{const parsed=new URL(req.url,'http://localhost');if(await pages.handle(req,res,url,Object.fromEntries(parsed.searchParams),(status,body)=>json(res,status,body),{signedIn:Boolean(sessionUser)}))return;}catch(e){if(res.destroyed)return;return error(res,e.status??400,e.code??'invalid_request',e.message);}
  if(url==='/models'&&req.method==='GET')return sendHtml(res,200,modelsPage({signedIn:Boolean(sessionUser)}));
  if(url==='/chat'&&req.method==='GET'){const state=await readiness();return sendHtml(res,200,chatPage({model,ready:state.ready,codingAgent:state.formalizer}));}
  if(url==='/v1/status'&&req.method==='GET')return json(res,200,await serverStatus({queryParser,memories,warm:server.warm??null,startedAt,defaultBase}));
  if(url==='/readyz'&&req.method==='GET'){const state=await readiness();return json(res,state.ready?200:503,state);}
  if(url==='/v1/models'&&req.method==='GET'){
   const state=await readiness();
   const own=mrpModels?mrpModels.list().map(m=>({id:m.id,object:'model',created:Math.floor(Date.parse(m.created_at)/1000)||0,owned_by:'mrp-llm',mrp:{name:m.name,description:m.description,base:m.base,profile:m.profile,language:m.language,default:m.id===defaultModel}})):[];
   return json(res,200,{object:'list',default:defaultModel??model,data:[...own,{id:model,object:'model',created:0,owned_by:'mrp-llm',mrp:{name:'Server default',description:'The server default: the default model when one exists, else the bare symbolic core.'},chatsop:{formalizer:state.formalizer,ready:state.ready}}]});
  }
  if((url==='/review'||url?.startsWith('/v1/knowledge/'))&&await knowledge.handle(req,res,url,Object.fromEntries(new URL(req.url,'http://localhost').searchParams),{admin:Boolean(sessionUser)||(!auth&&Boolean(legacy)),user}))return;
  if(mrpRoutes&&url?.startsWith('/v1/mrp/')&&await mrpRoutes.handle(req,res,url,{admin:Boolean(sessionUser)||(!auth&&Boolean(legacy)),user}))return;
  if(product&&url?.startsWith('/v1/')&&await product.handle(req,res,url,{admin:Boolean(sessionUser)||(!auth&&Boolean(legacy)),user}))return;
  if(url?.startsWith('/v1/')&&await api.handle(req,res,url))return;
  if(['/v1/responses','/v1/embeddings'].includes(url)||url?.startsWith('/v1/tools'))return error(res,501,'not_implemented','This API surface is not implemented');
  if(url!=='/v1/chat/completions'||req.method!=='POST')return error(res,404,'not_found','Endpoint not found');
  if(active>=maxConcurrent)return error(res,429,'concurrency_limit','Server concurrency limit reached');
  let key,parseRecord=null;try{
   const body=await readBody(req,maxRequestBytes),text=checkBody(body,acceptedModels,maxContextBytes);
   if(body.user!==undefined&&body.user!==user)throw Error('Authenticated user mismatch');
   const conversation=body.conversation_id??'default';if(typeof conversation!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(conversation))throw Error('Invalid conversation_id');
   // Session mode (DS022): the turn runs in the session's own repository (a clone of its base memory). A request without session_id
   // uses one automatic session per user and conversation on the default base memory.
   const isAdmin=Boolean(sessionUser)||(!auth&&Boolean(legacy));
   let rt=null,sessionId=null;
   if(runtimes){
    if(body.session_id!==undefined&&(typeof body.session_id!=='string'||! /^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.session_id)))throw invalid('Invalid session_id','invalid_session');
    // The model of the turn (DS025): the request's `model` when it names an MRP model, else the session's model, else the default model.
    const asked=mrpModels?.exists(body.model)?body.model:null;
    if(body.session_id===undefined&&mrpModels){const mid=asked??defaultModel;if(mid){const m=mrpModels.get(mid);sessionId=runtimes.autoSession(user,conversation,{base:m.base,model:mid});}}
    sessionId??=body.session_id??runtimes.autoSession(user,conversation);
    rt=runtimes.open(sessionId,{user,admin:isAdmin});
   }
   key=rt?'session\0'+sessionId:user+'\0'+conversation;if(busy.has(key))return error(res,409,'conversation_busy','Conversation has an active request');
   const entry=rt?rt.entry(user):sessions.get(user,conversation,base);let system=null;
   const sessionModel=rt?.info?.settings?.model,modelId=mrpModels?(body.session_id!==undefined&&mrpModels.exists(sessionModel)?sessionModel:mrpModels.exists(body.model)?body.model:mrpModels.exists(sessionModel)?sessionModel:defaultModel):null;
   const metadata=body.metadata??{},requestLayer={slots:metadata.slots??null,language:metadata.language??null};
   if(Object.keys(metadata).some(k=>!['slots','language'].includes(k)))throw invalid('metadata accepts slots and language');
   busy.add(key);active++;
   const turnStarted=performance.now();
   const work=(async()=>{
    if(body.chatSop){const source=checkedTrusted(body.chatSop.trustedSop),stored=await new Runtime({repo:rt?rt.repo:repo,session:entry.agent.session,schema:(rt?.lexicon??lexicon).predicates,lexicon:rt?.lexicon??lexicon,policy:{...config.policy,allowRules:false,allowPin:false}}).run(source);system={source,receipt:stored.result};}
    // The turn through ChatSOPAdapter (lib/adapter): stepwise runs the step-by-step formalizer (server/query-parser.mjs) in the session's
    // chat turn; routed and direct-verified formalize the message as a self-contained problem, verify by agreement and reply through the
    // conversation layer with the verification status.
    // MRP slots before the core (lib/mrp/pipeline.mjs): normalize to English, reflex, affect. A reflex answer ends the turn here.
    const history=rt&&sessionStore?sessionStore.transcript(sessionId,{limit:40}).map(e=>({role:e.role,text:e.role==='user'?(e.english??e.text):e.text})):[];
    const pre=modelId?await mrp.before({modelId,text,history,memoryReflexes:(rt?.lexicon??lexicon)?.reflexes??[],session:{slots:rt?.info?.settings?.slots??null,language:rt?.info?.settings?.language??null},request:requestLayer}):null;
    const circuitsBefore=rt&&sessionStore?sessionStore.circuits(sessionId).map(c=>c.name):[];
    if(pre?.reflex){
     const said=await mrp.reflexReply({pre});
     const result={text:said.text,englishText:said.english,sop:'',executionSop:'',cnl:said.english,packet:{status:'reflex',reflex:pre.reflex},trace:[],userStatements:[],carriedStatements:[],modelAssumptions:[]};
     const traceId='chatcmpl-'+randomUUID();let turn=null;
     if(rt){rt.save(entry,user);turn=sessionStore.nextTurn(sessionId);sessionStore.appendTranscript(sessionId,{role:'user',text,english:pre.english,turn});sessionStore.appendTranscript(sessionId,{role:'assistant',text:result.text,status:'reflex',turn,trace_id:traceId,message:text,model:modelId,reflex:pre.reflex});}
     return {result,author:{id:'reflex',label:'Reflex ('+pre.effective.slots.reflex.strategy+')'},system,rt,sessionId,traceId,turn,mode:'reflex',mrp:{model:modelId,original:text,english:pre.english,language:pre.language,output:pre.output,reflex:pre.reflex,slots:pre.effective.slots,overridden:pre.effective.overridden,trace:said.trace}};
    }
    const message=pre?pre.english:text;
    const lex=rt?.lexicon??lexicon,choice=checkAdapterOptions(body.adapter),{mode:asked,...options}=choice;
    const formalizeSlot=pre?.effective.slots.formalize,modelMode=formalizeSlot?({Routed:'routed',DirectVerified:'direct-verified'}[formalizeSlot.strategy]??'stepwise'):null;
    // The session's own formalization settings (Settings tab: strategy, first tier, answer mode) override the Model's formalize slot when the Model allows overrides.
    const sessionWins=!pre||pre.effective.model.allowOverrides;
    const mode=asked??(sessionWins?rt?.info?.settings?.adapter_mode:null)??modelMode??rt?.info?.settings?.adapter_mode??adapter.settings.mode;
    // The turn itself (circuit author, adapter, result assembly) is lib/adapter/chat-turn.mjs, shared with every evaluation harness.
    const stepStrategy=['LocalLLMStepByStep','InternalReasoningStepByStep','DirectSOP','SchemaGuidedLLM','SchemaOrDirect','Ensemble','EnsembleOneShot','DependencyScaffold','SpladeRouted','SaeRouted','FrameGuided','CNL-ACE','FineTunedSOP'].includes(formalizeSlot?.strategy)?formalizeSlot.strategy:null;
    // The reason and verify slots of the Model (DS025): a named engine and the verification policy reach the turn's runtime policy.
    // The retrieve slot (lib/mrp/retrieve.mjs): candidate predicates for the one-shot formalizers, computed on the English text.
    let retrieval=null;
    if(pre&&pre.effective.slots.retrieve.strategy!=='slice'){const rv=pre.effective.slots.retrieve,mid=pre.effective.model.base,t0=performance.now();
     retrieval=await retrieveCandidates({strategy:rv.strategy,params:rv.params,memory:mid,english:pre.english,lexicon:memories.lexicon(mid),circuits:memories.layeredCircuits(mid)});
     pre.trace.push({slot:'retrieve',strategy:rv.strategy,ms:Math.round(performance.now()-t0),candidates:(retrieval?.predicates??[]).map(p=>p.id)});}
    if(pre){const r=pre.effective.slots.reason,v=pre.effective.slots.verify;entry.agent.turnPolicy={...(retrieval?{retrieval}:{}),...(pre.effective.slots.link.strategy!=='knowledge-linker'?{link:pre.effective.slots.link.strategy}:{}),...(r.strategy==='engine'?{reasoningStrategy:r.params.engine}:{}),...(v.strategy==='oracle-always'?{verify:'always'}:v.strategy==='off'?{verify:'never'}:v.strategy==='cross-engine'?{crossEngine:v.params.engine}:{})};}
    const turned=await chatTurn({adapter,agent:entry.agent,queryParser,lexicon:lex,message,mode,options,source:'chat',preferredModel:(sessionWins?rt?.info?.settings?.formalizer_model??rt?.info?.settings?.omp_model:null)??formalizeSlot?.params?.tier??null,strategy:(sessionWins?rt?.info?.settings?.formalizer:null)??stepStrategy??null}).catch(e=>{parseRecord=e.parse??null;entry.agent.turnPolicy=null;throw e;});
    parseRecord=turned.parse;entry.agent.turnPolicy=null;
    const {result,author,answered}=turned;
    // The deterministic English answer stays in the trace; a faithful phrasing in the message's language replaces the shown text.
    let mrpInfo=null;
    if(pre){const post=await mrp.after({pre,result,parse:parseRecord});result.englishText=post.english;result.text=post.text;mrpInfo={model:modelId,original:text,english:pre.english,language:pre.language,output:pre.output,reflex:null,affect:pre.affect,roundtrip:post.roundtrip,slots:pre.effective.slots,overridden:pre.effective.overridden,trace:post.trace};}
    else if(answerFormulator&&!result.packet?.localized){const phrased=await answerFormulator.formulate({message:text,english:result.text,packet:result.packet??{}});result.answerLanguage={...phrased,text:undefined};if(phrased.applied)result.text=phrased.text;}
    // The turn record (DS022 "Chat feedback"): the assistant entry of the session transcript carries the turn number, the trace id and what
    // produced the answer, so a vote (POST /v1/feedback {session, turn}) is joined to it on the server.
    const traceId='chatcmpl-'+randomUUID();let turn=null;
    if(rt){rt.save(entry,user);turn=sessionStore.nextTurn(sessionId);sessionStore.appendTranscript(sessionId,{role:'user',text,...(pre?{english:pre.english}:{}),turn});sessionStore.appendTranscript(sessionId,{role:'assistant',text:result.text,status:result.packet?.status??null,turn,trace_id:traceId,message:text,adapter_mode:answered.mode,strategy:parseRecord?.strategy??null,model:parseRecord?.model??result.formalization?.model??null,model_sop:result.sop??null,circuit:result.executionSop??null,reasoning_strategy:result.packet?.reasoningStrategy??null,backend:result.packet?.route?.backend??result.packet?.backend??null});}else sessions.save(entry,user,conversation,base);
    // Commit policy of the model (DS025 "Commit policy"): definitions admitted into the session during this turn.
    if(pre&&rt&&sessionStore){const added=sessionStore.circuits(sessionId).filter(c=>!circuitsBefore.includes(c.name));const policy=pre.effective.slots.commit.strategy;
     if(added.length&&(policy==='review-queue'||policy==='auto-validated')){const circuits=added.map(c=>({name:c.name,text:c.text}));
      try{if(policy==='review-queue'){mrpModels.queueReview(modelId,{session:sessionId,turn,circuits,message:text});mrpInfo.commit={policy,queued:circuits.length};}
       else{const w=writeToBase({memories,model:pre.effective.model,circuits,approvedBy:'auto-validated:'+user,reason:'auto-validated commit of model '+modelId,source:'session:'+sessionId});mrpInfo.commit={policy,written:w.added.length};}}
      catch(e){mrpInfo.commit={policy,error:e.message};}}}
    return {result,author,system,rt,sessionId,traceId,turn,mode:answered.mode,mrp:mrpInfo};
   })();work.finally(()=>{active--;busy.delete(key);}).catch(()=>{});
   const done=await Promise.race([work,new Promise((_,reject)=>{const timer=setTimeout(()=>{const e=new Error('Request time limit reached');e.status=504;reject(e);},timeoutMs);timer.unref();work.finally(()=>clearTimeout(timer)).catch(()=>{});})]);
   if(res.destroyed)return;const data=completion(done.result,body.model,{id:done.author.id,label:done.author.label},done.system,parseRecord,done.traceId);data.chatSop.turn_ms=Math.round(performance.now()-turnStarted);if(done.mrp){data.mrp=done.mrp;data.chatSop.mrp=done.mrp;data.model=done.mrp.model;}data.chatSop.trace_id=data.id;if(done.rt){data.chatSop.session={id:done.sessionId,model:done.rt.info.settings?.model??null,language:done.rt.info.settings?.language??null,base:done.rt.info.base,formalizer:done.rt.info.settings?.formalizer??null,adapter_mode:done.rt.info.settings?.adapter_mode??null};data.chatSop.turn=done.turn;}if(body.stream)sse(res,data);else json(res,200,data);
  }catch(e){if(res.destroyed)return;
   // No model of the subscription chain could run (503), or the models ran and no valid circuit came back (422): the parse record says which models were tried and why they failed.
   if(e.code==='strategy_unavailable')return json(res,503,{error:{message:e.message,type:'invalid_request_error',code:'strategy_unavailable'}});
   if(e.code==='parse_unavailable')return json(res,503,{error:{message:'The request parser cannot produce a circuit: '+e.message,type:'invalid_request_error',code:'parse_unavailable'},chatSop:{status:'parse_unavailable',parse:e.parse??parseRecord,reason:String(e.message).slice(0,500)}});
   if(e.code==='parse_failed')return json(res,422,{error:{message:'The request parser wrote no valid circuit: '+e.message,type:'invalid_request_error',code:'parse_failed'},chatSop:{status:'rejected',parse:e.parse??parseRecord,rejection:String(e.message).slice(0,500)}});
   // The circuit was written but not admitted or could not be executed: 422 with what the author wrote, so the chat can show it.
   if(e.modelSop!==undefined)return json(res,422,{error:{message:'The circuit was not admitted or could not be executed',type:'invalid_request_error',code:'model_output_rejected'},chatSop:{status:'rejected',parse:e.parse??parseRecord,rejection:String(e.message).slice(0,500),model_sop:e.modelSop,formalizer_model:e.formalization?.model??null,formalization_ms:e.formalization?.ms??null}});
   const status=e.status??(e.name==='TimeoutError'||e.message==='Request time limit reached'?504:400);error(res,status,(e.status&&e.code)||(status===413?'request_limit':status===504?'time_limit':status===400?'invalid_request':'internal_error'),status===400&&!e.status?'Invalid SOP or request; no detail exposed':status===504?'Request time limit reached':e.status?e.message:'Server request failed');}
 });server.config=config;server.auth=auth;server.capabilities=capabilities;server.sessions=sessionStore;server.memories=memories;server.authoring=authoring;server.feedback=feedback;server.knowledge=knowledge;server.queryParser=queryParser;server.defaultBase=defaultBase;server.models=mrpModels;server.defaultModel=defaultModel;
 server.on('close',()=>capabilities.close());
 // A managed local model server (a step-by-step strategy with an explicit GGUF) stops with the chat server.
 server.on('close',()=>{queryParser.stop?.().catch(()=>{});});
 return server;
}
export async function startServer({configPath=path.join(root,'config/runtime.json'),host=process.env.CHATSOP_HOST??'0.0.0.0',port=Number(process.env.CHATSOP_PORT??9999)}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
 const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 const project=path.resolve(root),lexicon=demoLexicon();  // the lexicon of the code paths without sessions; every chat session uses its own base memory's lexicon
 // Chat data (DS022): every chat lives under one gitignored root. The runtime repository is the default base memory's own repository;
 // it is only a placeholder for the code paths without sessions, which session mode never uses for a chat.
 const chatData=ChatData.open(config,process.env,project),bases=new BaseMemories({chatData,memory:config.memory});
 const repo=bases.repository(ensureDefaultBase(bases,config));
 const stopCleanup=chatData.scheduleCleanup(report=>{if(report.error)console.error('chat data cleanup failed: '+report.error);else if(report.tmp.length||report.sessions.length)console.log('chat data cleanup removed '+report.tmp.length+' tmp folders and '+report.sessions.length+' abandoned sessions');});
 const auth=new Auth({file:path.resolve(project,config.auth?.file??'state/auth.json'),apiKey:process.env.CHATSOP_API_KEY??null});
 const server=createServer({config,repo,lexicon,auth,base:'main',limits:config.server?.limits,chatData});
 server.on('close',stopCleanup);
 await new Promise((resolve,reject)=>server.once('error',reject).listen(port,host,resolve));
 // Warmup (DS009 "Warm memories"): the base memories named by `server.warmMemories` are decoded in the background; the server is usable at once. CHATSOP_WARMUP=0 or `server.warmup: false` turns it off.
 if(config.server?.warmup!==false&&process.env.CHATSOP_WARMUP!=='0')setImmediate(()=>{try{const ids=[...new Set([server.defaultBase,...(config.server?.warmMemories??['world-v1'])].filter(Boolean))];if(server.memories&&ids.length)server.warm=[];for(const r of warmMemories({memories:server.memories,ids})){server.warm.push(r);console.log('warmup: base memory '+r.id+(r.skipped?' skipped ('+r.skipped+')':' warm in '+r.ms+' ms ('+r.facts+' facts, '+r.layers+' layers)'));}}catch(e){console.error('warmup of base memories failed: '+e.message);}});
 return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){startServer({configPath:process.env.CHATSOP_CONFIG??path.join(root,'config/runtime.json')}).then(server=>console.log('ChatSOP listening on '+JSON.stringify(server.address())+'\n  home (sign in, chat, admin): http://127.0.0.1:'+server.address().port+'/\n  documentation: http://127.0.0.1:'+server.address().port+'/docs/')).catch(e=>{console.error(e.message);console.error('\nHint: `npm start` generates a token, serves the documentation and prints the access URLs.');process.exitCode=1;});}
