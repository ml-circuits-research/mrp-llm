import test from 'node:test';import assert from 'node:assert/strict';import {lex} from '../helpers.mjs';import {Lexicon} from '../../sop/lexicon.mjs';
// English-only core (owner decision 2026-10-01): the lexicon links English; other languages are translated at the edges.
test('a candidate in English reaches works_at',()=>assert.ok(lex.candidates('Maria works at Alpha Lab.').predicates.some(x=>x.id==='works_at')));
for(const text of ['Maria lucrează la Alfa.','Maria arbeitet bei Alfa.','Maria travaille chez Alfa.','Maria lavora presso Alfa.'])
 test('a non-English sentence is not linked by the core lexicon: '+text,()=>assert.ok(!lex.candidates(text).predicates.some(x=>x.id==='works_at')));
test('same-name entities stay ambiguous',()=>{
 const l=new Lexicon('@ion1 entity\n  kind person\n  label ro "Ion"\n@ion2 entity\n  kind person\n  label ro "Ion"');
 const c=l.candidates('Ion a venit.');
 assert.equal(c.entities.length,2);
 assert.equal(c.ambiguities.length,1);
});
test('employment and contracting are not synonyms',()=>{
 const c=lex.candidates('Maria is a contractor for Alpha Lab.');
 assert.ok(c.predicates.some(x=>x.id==='contractor_for'));
 assert.ok(!c.predicates.some(x=>x.id==='employed_by'));
});
test('negation cues remain visible to the lexicon',()=>assert.ok(lex.candidates('Maria does not work at Alpha Lab.').polarityCues.includes('not')));
test('oversize utterance is not silently truncated',()=>assert.throws(()=>lex.candidates('x'.repeat(2000)),/Lexical input size limit/));
test('word boundary avoids a short alias inside another word',()=>{const l=new Lexicon('@ana entity\n  kind person\n  label ro "Ana"');assert.equal(l.candidates('banana').entities.length,0);});
test('approved English names resolve to one canonical identity with version and provenance',()=>{
 const english=lex.resolve('Alpha Lab',{language:'en',kind:'entity',type:'organization'});
 assert.equal(english.id,'lab_alpha');
 assert.equal(english.version,lex.version);assert.equal(english.provenance,lex.provenance);
 assert.equal(lex.resolve('works at',{language:'en',kind:'predicate'}).id,'works_at');
 assert.equal(lex.resolve('lucrează la',{language:'en',kind:'predicate'}).status,'unknown');
});
test('the shipped knowledge holds no label, alias or lexeme in another language',()=>{
 for(const e of lex.entries)assert.ok(['en','und'].includes(e.language),e.id+' has a '+e.language+' surface');
});
test('accent-folded collisions remain ambiguous and exact language and kind constrain identity',()=>{
 const l=new Lexicon('@one entity\n  kind place\n  label ro "Șura"\n@two entity\n  kind place\n  label ro "Súra"\n@not_a_place predicate\n  args place\n  label ro "Șura"');
 assert.deepEqual(l.resolve('sura',{language:'ro',kind:'entity'}).candidates.map(x=>x.id),['one','two']);
 assert.equal(l.resolve('Șura',{language:'ro',kind:'entity'}).id,'one');
 assert.equal(l.resolve('Șura',{language:'ro',kind:'predicate'}).id,'not_a_place');
 assert.equal(l.resolve('sura',{language:'en',kind:'entity'}).status,'unknown');
});
test('polysemy needs explicit host domain or entity type, never a score winner',()=>{
 const l=new Lexicon('@financial entity\n  kind organization\n  domain finance\n  label en "bank"\n@river entity\n  kind place\n  domain geography\n  label en "bank"');
 assert.equal(l.resolve('bank',{language:'en',kind:'entity'}).status,'ambiguous');
 assert.equal(l.resolve('bank',{language:'en',kind:'entity',domain:'geography'}).id,'river');
 assert.equal(l.resolve('bank',{language:'en',kind:'entity',type:'organization'}).id,'financial');
 assert.equal(l.resolve('bank',{language:'en',kind:'entity',domain:'politics'}).status,'unknown');
 assert.deepEqual(l.candidates('bank',{language:'en'}).ambiguities.map(a=>a.ids),[['financial','river']]);
});
test('subsumption, direction, and absent aliases never silently merge',()=>{
 assert.equal(lex.resolve('mother',{language:'en',kind:'predicate'}).id,'mother');
 assert.notEqual(lex.resolve('mother',{language:'en',kind:'predicate'}).id,lex.resolve('parent',{language:'en',kind:'predicate'}).id);
 assert.notEqual(lex.resolve('works at',{language:'en',kind:'predicate'}).id,lex.resolve('employed by',{language:'en',kind:'predicate'}).id);
 assert.equal(lex.resolve('child of',{language:'en',kind:'predicate'}).status,'unknown');
 assert.equal(lex.resolve('workz at',{language:'en',kind:'predicate'}).status,'unknown');
});
test('a class is a scoped entity of kind class, not an invented predicate',()=>{
 const l=new Lexicon('@personhood entity\n  kind class\n  domain identity\n  label en "personhood"\n  label ro "calitatea de persoană"');
 assert.equal(l.resolve('personhood',{language:'en',kind:'entity',domain:'identity'}).id,'personhood');
 assert.equal(l.resolve('calitatea de persoană',{language:'ro',kind:'entity',domain:'identity'}).id,'personhood');
 assert.equal(l.resolve('personhood',{language:'en',kind:'entity',domain:'finance'}).status,'unknown');
 assert.equal(l.resolve('personhood',{language:'en',kind:'predicate'}).status,'unknown');
 assert.ok(l.isClass('personhood'));
 assert.deepEqual(l.candidates('personhood',{language:'en'}).entities.map(c=>c.id),['personhood']);
});
test('pre-formalizer mention resolution uses the same exact-before-fold rule as resolve',()=>{
 const l=new Lexicon('@mara entity\n  kind person\n  label ro "Mara"\n@accented entity\n  kind person\n  label ro "Mára"');
 assert.equal(l.resolve('Mara',{language:'ro',kind:'entity'}).id,'mara');
 assert.deepEqual(l.candidates('Mara a venit.',{language:'ro'}).entities.map(e=>e.id),['mara']);
 assert.deepEqual(l.candidates('Mara a venit.',{language:'ro'}).ambiguities,[]);
});
test('an independent short mention retains ambiguity even when an earlier long name ranked best',()=>{
 const l=new Lexicon('@doctor entity\n  kind person\n  label en "Dr Ana"\n  alias en "Ana"\n@other entity\n  kind person\n  label en "Ana"');
 assert.deepEqual(l.candidates('Dr Ana',{language:'en'}).ambiguities,[]);
 const matches=l.candidates('Dr Ana met Ana',{language:'en'});
 assert.deepEqual(matches.ambiguities.map(a=>a.ids),[['doctor','other']]);
});
test('a role typed with a superclass resolves entities of its subclasses through is_a',()=>{
 const l=new Lexicon('@country entity\n  kind class\n  label en "country"\n\n@place entity\n  kind class\n  label en "place"\n\n@f1 fact\n  holds is_a country place\n\n@france entity\n  kind country\n  label en "France"');
 assert.equal(l.resolve('France',{language:'en',kind:'entity',type:'country'}).id,'france');
 assert.equal(l.resolve('France',{language:'en',kind:'entity',type:'place'}).id,'france');
 assert.equal(l.resolve('France',{language:'en',kind:'entity',type:'person'}).status,'unknown');
});
