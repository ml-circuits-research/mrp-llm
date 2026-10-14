import {assert} from '../lib/util.mjs';
import {parseExpression} from './expression.mjs';
import {COMPARATOR_WORDS,ARITHMETIC_WORDS} from './enums.mjs';

/** Structural words of condition fields (DS004 Boolean groups, DS014 match blocks): the group openers, the
 * match-block opener and the closer of both. They are grammar, not wire fields; the SOP highlighter
 * (server/pages/sop-code.mjs) reads them from here. */
export const GROUP_OPENERS=Object.freeze(['all','any']);
export const MATCH_OPENER='match';
export const BLOCK_CLOSER='end';
export const BLOCK_OPENERS=Object.freeze([...GROUP_OPENERS,MATCH_OPENER]);
export const SYNTAX_WORDS=Object.freeze([...BLOCK_OPENERS,BLOCK_CLOSER]);
const opens=text=>BLOCK_OPENERS.includes(text);

/** The fields whose value may be a condition block, per wire type. */
export const CONDITION_FIELDS=Object.freeze({query:Object.freeze(['where','scope','filter','compare']),constraint:Object.freeze(['require','claim'])});
export function conditionField(type,key){
 return Object.hasOwn(CONDITION_FIELDS,type)&&CONDITION_FIELDS[type].includes(key);
}

/** Explicit groups preserve nesting; ordinary leaf syntax belongs to the caller. */
export function parseCondition(source,parseLeaf){
 const lines=source.split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
 let cursor=0;
 function next(depth){
  assert(depth<=32,'Condition nesting limit');
  const text=lines[cursor++];
  assert(text&&text!==BLOCK_CLOSER,'Expected a condition');
  // A `match` leaf spans its keyword lines up to `end` (model-language query propositions).
  if(text===MATCH_OPENER){const body=[];while(cursor<lines.length&&lines[cursor]!==BLOCK_CLOSER)body.push(lines[cursor++]);assert(lines[cursor++]===BLOCK_CLOSER,'Unclosed match block');return parseLeaf([MATCH_OPENER,...body].join('\n'));}
  if(!GROUP_OPENERS.includes(text))return parseLeaf(text);
  const children=[];
  while(cursor<lines.length&&lines[cursor]!==BLOCK_CLOSER)children.push(next(depth+1));
  assert(lines[cursor++]===BLOCK_CLOSER,'Unclosed '+text+' condition');
  assert(children.length>0,'Empty '+text+' condition');
  return {kind:text,children};
 }
 const result=next(0);
 assert(cursor===lines.length,'Unexpected text after condition');
 return result;
}

const WORD_TERM=/^(?:[?$][A-Za-z][A-Za-z0-9_]*|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*")$/;
const tokensOf=text=>text.match(/"(?:\\.|[^"\\])*"|\S+/g)??[];
/** Is a condition leaf written in words (`?x at_least 5`, `?a times 19`)? DS014 "Words, not operators". */
export const isWordForm=text=>tokensOf(String(text)).some(token=>Object.hasOwn(COMPARATOR_WORDS,token)||Object.hasOwn(ARITHMETIC_WORDS,token));
/** One words-only leaf as the equivalent expression text: terms joined by arithmetic and comparator words. */
export function wordsToExpression(text,{comparator=true}={}){
 const tokens=tokensOf(String(text));
 assert(tokens.length%2===1&&(tokens.length>=3||!comparator),'words_form: a comparison is TERM COMPARATOR TERM, with plus/minus/times/divided_by between terms');
 let comparators=0;
 const out=tokens.map((token,index)=>{
  if(index%2===0){assert(WORD_TERM.test(token),'words_form: '+token+' is not a ?variable, a number or a quoted string');return token;}
  if(Object.hasOwn(COMPARATOR_WORDS,token)){comparators++;return COMPARATOR_WORDS[token];}
  assert(Object.hasOwn(ARITHMETIC_WORDS,token),'words_form: '+token+' is not one of '+[...Object.keys(COMPARATOR_WORDS),...Object.keys(ARITHMETIC_WORDS)].join(', '));
  return ARITHMETIC_WORDS[token];
 });
 assert(comparators===(comparator?1:0),comparator?'words_form: exactly one comparator word per line':'words_form: an arithmetic expression has no comparator word');
 return out.join(' ');
}
const parseLeaf=text=>parseExpression(isWordForm(text)?wordsToExpression(text):text);

/** Filters and numeric constraints share the existing typed expression lowering; a leaf may be written in words. */
export function parseBooleanCondition(source){
 const convert=node=>{
  if(!node.children)return node;
  return node.children.map(convert).reduce((left,right)=>({type:'binary',op:node.kind==='all'?'&&':'||',left,right}));
 };
 return convert(parseCondition(source,parseLeaf));
}

export function formatCondition(source){
 let depth=0;
 return source.split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('#')).map((line,i)=>{
  if(line===BLOCK_CLOSER)depth--;
  const text=(i?'  '.repeat(depth+1):'')+line;
  if(opens(line))depth++;
  return text;
 }).join('\n');
}
