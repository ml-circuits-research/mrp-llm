import {assert} from './util.mjs';
export function instant(value,{upper=false}={}){
 if(value==='open')return Infinity;if(value==='beginning')return -Infinity;
 if(typeof value==='number'){assert(Number.isSafeInteger(value),'Invalid timestamp');return value;}
 assert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value),'Use ISO date or UTC timestamp: '+value);
 const n=Date.parse(value);assert(Number.isFinite(n),'Invalid date');assert(new Date(n).toISOString().slice(0,10)===value.slice(0,10),'Invalid calendar date');return n;
}
export const formatTime=n=>n===Infinity?'open':n===-Infinity?'beginning':new Date(n).toISOString();
export function interval(text){if(text==='timeless')return {from:-Infinity,until:Infinity};const p=text.trim().split(/\s+/);assert(p.length===2,'valid/during needs start and exclusive end');const from=instant(p[0]),until=instant(p[1],{upper:true});assert(from<until,'Interval must have positive duration');return {from,until};}
export function intersect(...spans){const from=Math.max(...spans.map(t=>t.from)),until=Math.min(...spans.map(t=>t.until));return from<until?{from,until}:null;}
export const contains=(span,t)=>span.from<=t&&t<span.until;
export const serialInterval=t=>({from:formatTime(t.from),until:formatTime(t.until)});
export const readInterval=t=>({from:instant(t.from),until:instant(t.until)});
