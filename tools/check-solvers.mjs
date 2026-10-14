#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {cliArgs,saveJSON} from '../lib/util.mjs';
const a=cliArgs(),root=fileURLToPath(new URL('../',import.meta.url)),resource=file=>path.resolve(root,file),out=a.out??resource('eval/reports/current/solvers.json');const report={neuralModelTested:false,backends:{}};
for(const [name,command,args]of [['z3',process.env.Z3_BIN??'z3',['-version']],['prolog',process.env.SWIPL_BIN??'swipl',['--version']]]){const r=spawnSync(command,args,{encoding:'utf8',timeout:5000});report.backends[name]={command,available:r.status===0,version:r.status===0?r.stdout.trim():null,error:r.error?.code??(r.status!==0?'not installed':null)};}
const generated=resource('eval/reports/current/generated');fs.mkdirSync(generated,{recursive:true});for(const [command,file,target]of [['compile-smt','examples/constraint.sop','example.smt2'],['compile-prolog','examples/local.sop','example.pl']]){const r=spawnSync(process.execPath,[resource('server/cli.mjs'),command,'--file',resource(file)],{encoding:'utf8',timeout:10000});if(r.status!==0)throw Error(r.stderr);fs.writeFileSync(path.join(generated,target),r.stdout);}
saveJSON(out,report);console.log(JSON.stringify(report,null,2));
