import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {shardPaths,readJsonlShardedSync} from './jsonl-shards.mjs';
export function stable(x) {
  if (Array.isArray(x)) return '['+x.map(stable).join(',')+']';
  if (x && typeof x==='object') return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
export const digest=x=>crypto.createHash('sha256').update(typeof x==='string'?x:stable(x)).digest('hex');
export function atomic(file, data){if(file instanceof URL)file=fileURLToPath(file);fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,data);fs.renameSync(temp,file);}
export function loadJSON(file, fallback){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):structuredClone(fallback);}
export const saveJSON=(file,data)=>atomic(file,JSON.stringify(data,null,2)+'\n');
export function checkName(s){if(typeof s!=='string'||['__proto__','prototype','constructor'].includes(s)||! /^[A-Za-z0-9_-]{1,80}$/.test(s))throw Error('Identifier must contain 1..80 ASCII letters, digits, _ or -.');return s;}
export const variable=x=>typeof x==='string' && /^\?[a-z][a-z0-9_]*$/i.test(x);
export function cliArgs(args=process.argv.slice(2)){const out={_:[]};for(let i=0;i<args.length;i++){let a=args[i];if(a.startsWith('--')){a=a.slice(2);out[a]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}else out._.push(a);}return out;}
// A .jsonl path stored as shards (lib/jsonl-shards.mjs) is read transparently; any other path reads the single file.
export function readJSONL(file){if(typeof file==='string'&&file.endsWith('.jsonl')&&shardPaths(file).some(p=>p!==file))return readJsonlShardedSync(file);return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(x=>x.trim()).map((l,i)=>{try{return JSON.parse(l);}catch(e){throw Error(`${file}:${i+1}: ${e.message}`);}});}
export const writeJSONL=(file,rows)=>atomic(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
export function assert(cond,message){if(!cond)throw Error(message);}
