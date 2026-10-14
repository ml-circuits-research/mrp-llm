#!/usr/bin/env node
import '../lib/env-aliases.mjs';
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import readline from 'node:readline/promises';import {stdin,stdout} from 'node:process';
import {cliArgs,loadJSON} from '../lib/util.mjs';import {Repository} from '../memory/repository.mjs';import {Lexicon} from '../sop/lexicon.mjs';import {Runtime} from '../sop/runtime.mjs';import {Agent} from './agent.mjs';import {createQueryParser,queryParserSettings} from './query-parser.mjs';import {publishKnowledge} from '../sop/ingest.mjs';import {parse,validateGraph,canonical} from '../sop/parser.mjs';import {lowerConstraint,lowerFact,lowerRule} from '../sop/lower.mjs';import {compileSMT} from '../reasoning/bridge/export.mjs';import {compileProlog} from '../reasoning/bridge/export.mjs';import {instant,contains} from '../lib/time.mjs';
const args=cliArgs(),cmd=args._[0]??'help',projectRoot=fileURLToPath(new URL('../',import.meta.url)),resource=file=>path.resolve(projectRoot,file),input=file=>path.isAbsolute(file)||fs.existsSync(file)?file:resource(file),config=loadJSON(args.config?input(args.config):resource('config/runtime.json'),null);
try{
 if(cmd==='help'){console.log(`ChatSOP\n  node server/cli.mjs init [--base demo]\n  node server/cli.mjs run --file examples/query.sop [--base demo --user alice --session s1]\n  node server/cli.mjs chat                             # the product chain: the step-by-step formalizer asks a proxy tier short questions and assembles the circuit, the runtime answers in English\n  node server/cli.mjs fork --from demo --to copy\n  node server/cli.mjs commit|discard|stats|maintain [--base demo --user alice --session s1]
  node server/cli.mjs checkpoint-base [--base demo]
  node server/cli.mjs gc [--apply]                     # dry-run unless --apply
  node server/cli.mjs migrate|close-session [--base demo --user alice --session s1]
  node server/cli.mjs decay --steps 1 [--base demo --user alice --session s1]\n  node server/cli.mjs validate --file program.sop\n  node server/cli.mjs lexicon --text "Maria lucreaza la Alfa"\n  node server/cli.mjs compile-smt --file examples/constraint.sop\n  node server/cli.mjs compile-prolog --file examples/local.sop\n\nInput paths resolve from the current directory first, then from the project root.\ninit loads reviewed fictional fixtures; no model download is implicit. chat runs the product chain: the request parser of config/runtime.json writes the circuit, the runtime answers in English.`);process.exit(0);}
 const lex=(args.ontology?Lexicon.load(input(args.ontology)):demoLexicon());
 if(cmd==='validate'){const p=parse(fs.readFileSync(input(args.file),'utf8'));validateGraph(p);console.log(canonical(p));process.exit(0);}
 if(cmd==='lexicon'){console.log(JSON.stringify(lex.candidates(args.text??'',{language:args.language??'auto'}),null,2));process.exit(0);}
 if(cmd==='compile-smt'){const r=await new Runtime({schema:lex.predicates,lexicon:lex,policy:{allowWrite:false}}).run(fs.readFileSync(input(args.file),'utf8'));const c=Object.values(r.values).find(x=>x?.kind==='constraint');if(!c)throw Error('No constraint wire');const {prefix,claim}=compileSMT(c);console.log(prefix+'; claim is tested separately, not assumed true\n(push)\n(assert '+claim+')\n(check-sat)\n(pop)\n(push)\n(assert (not '+claim+'))\n(check-sat)\n(pop)');process.exit(0);}
 if(cmd==='compile-prolog'){const p=parse(fs.readFileSync(input(args.file),'utf8')),facts=p.wires.filter(w=>w.type==='fact').map(w=>lowerFact(w,{},lex.predicates)),rules=p.wires.filter(w=>w.type==='rule').map(w=>lowerRule(w,{},lex.predicates));const temporal=[...facts,...rules].some(x=>x.valid&&(x.valid.from!==-Infinity||x.valid.until!==Infinity));if(temporal&&!args.at)throw Error('Temporal Prolog export requires --at YYYY-MM-DD; temporal qualifiers are never silently dropped');const at=args.at?instant(args.at):0;console.log(compileProlog(facts.filter(f=>contains(f.valid,at)).map(f=>f.atom),rules.filter(r=>!r.valid||contains(r.valid,at))));process.exit(0);}
 const repo=new Repository(args.root??config.root??'state',{memory:config.memory}),base=args.base??'demo',user=args.user??'local',name=args.session??'s1';
 if(cmd==='init'){const r=publishKnowledge(repo,base,fs.readFileSync(resource('tests/fixtures/bootstrap.sop'),'utf8'),{schema:lex.predicates,reviewed:true,knownAt:Date.parse('2024-01-01')});console.log('Published fixture base '+base+' '+r.snapshot);process.exit(0);}
 if(cmd==='fork'){console.log(repo.fork(args.from,args.to));process.exit(0);}
 if(cmd==='checkpoint-base'){console.log(JSON.stringify(repo.checkpointBase(base),null,2));process.exit(0);}
 if(cmd==='gc'){console.log(JSON.stringify(repo.gc({dryRun:!args.apply}),null,2));process.exit(0);}
 const session=repo.session(base,user,name);
 if(cmd==='migrate'){console.log(JSON.stringify(repo.migrate(session),null,2));process.exit(0);}
 if(cmd==='close-session'){console.log(JSON.stringify(repo.closeSession(session)));process.exit(0);}
 if(cmd==='commit'){console.log(repo.commit(session));process.exit(0);}if(cmd==='discard'){repo.discard(session);console.log('Discarded uncommitted session changes.');process.exit(0);}if(cmd==='stats'){console.log(JSON.stringify(repo.stats(session),null,2));process.exit(0);}if(cmd==='maintain'){console.log(JSON.stringify(repo.maintain(session,{force:!!args.force}),null,2));process.exit(0);}if(cmd==='decay'){repo.decay(session,Number(args.steps??1));console.log(JSON.stringify(repo.stats(session),null,2));process.exit(0);}
 if(cmd==='run'){const r=await new Runtime({repo,session,schema:lex.predicates,lexicon:lex,policy:config.policy,now:args.now?Date.parse(args.now):Date.now()}).run(fs.readFileSync(input(args.file),'utf8'));console.log(args.json?JSON.stringify(r,null,2):(r.result.text??JSON.stringify(r.result,null,2)));process.exit(0);}
 if(cmd==='chat'){
  // The product chain (server/http.mjs): the step-by-step formalizer (config/runtime.json queryParser: questions to the proxy tier ladder) assembles the circuit, the runtime answers.
  const queryParser=createQueryParser({settings:queryParserSettings(config)});
  let parseRecord=null;
  const formalizer={id:'formalizer',formalize:async message=>{const done=await queryParser.parse({source:'cli',message,lexicon:lex,memoryKey:lex.circuitsSha256??null});parseRecord=done.parse;formalizer.id='formalizer:'+(done.parse.model??done.parse.strategy);return done.sop;}};
  const agent=new Agent({repo,session,lexicon:lex,config}),rl=readline.createInterface({input:stdin,output:stdout});
  console.log('Commands: :commit :discard :sop :circuit :cnl :proof :parse :quit. Your stated claims remain caller-owned conversation context; only explicit trusted writes enter the session.');
  let last;
  try{while(true){const text=await rl.question('> ');if(text===':quit')break;if(text===':commit'){console.log(repo.commit(session));continue;}if(text===':discard'){repo.discard(session);continue;}if(text===':sop'){console.log(last?.sop??'No previous turn');continue;}if(text===':circuit'){console.log(last?.executionSop??'No previous turn');continue;}if(text===':cnl'){console.log(last?.cnl??'No previous turn');continue;}if(text===':proof'){console.log(JSON.stringify(last?.packet??null,null,2));continue;}if(text===':parse'){console.log(JSON.stringify(parseRecord,null,2));continue;}try{last=await agent.turn(text,{formalizer});console.log(last.text);}catch(e){console.log((e.code==='parse_unavailable'?'No circuit (parse_unavailable): ':'No completed answer: ')+e.message);}}}
  finally{rl.close();}
  process.exit(0);}
 throw Error('Unknown command: '+cmd);
}catch(e){console.error(e.message);process.exitCode=1;}
