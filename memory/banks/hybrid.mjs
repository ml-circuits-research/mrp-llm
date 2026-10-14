/** Exact SQL answers plus independent associative hints. Both stores and their
 * byte costs are explicit. Hint failure can NEVER remove an exact answer.
 */
import {SQLiteBank} from './sqlite.mjs';
import {RecallMemory} from '../weaver.mjs';
import {HoloBank} from './holo.mjs';
// `hybrid.associative` names the hint bank; `weaver` and `holo` are the legacy spellings.
const HINT_BANKS={'recall-memory':RecallMemory,weaver:RecallMemory,'holo-memory':HoloBank,holo:HoloBank};
import {atom} from '../../lib/types.mjs';
import {assert} from '../../lib/util.mjs';
export class HybridBank {
 constructor(config={},state=null){this.config={...config,...state?.config,engine:'hybrid'};const kind=this.config.hybrid?.associative??'recall-memory';assert(Object.hasOwn(HINT_BANKS,kind),'hybrid.associative must be recall-memory or holo-memory');
  this.exact=state?SQLiteBank.from(state.exact):new SQLiteBank({...this.config,engine:'sqlite'});
  const C=HINT_BANKS[kind];this.associative=state?C.from(state.associative):new C({...this.config,engine:C===HoloBank?'holo-memory':'recall-memory'});this.writes=state?.writes??0;
 }
 get domains(){return this.exact.domains;}get receipts(){return this.exact.receipts;}
 add(a,meta={}){atom(a,{ground:true});const id=this.associative.add(a,meta);this.exact.add(a,meta);this.writes++;return id;}
 reinforce(a,meta={}){this.associative.reinforce(a,meta);return this.exact.reinforce(a,meta);}
 recall(a,opts={}){const exact=this.exact.recall(a,opts);return {...exact,rows:exact.rows.map(r=>({...r,evidence:{...r.evidence,verification:'hybrid-exact'}})),coverage:'hybrid-exact-retained-records'};}
 hints(a,opts={}){return this.associative.recall(a,opts);}
 search(t,o){return this.exact.search(t,o);}
 decay(steps=1){this.exact.decay(steps);this.associative.decay(steps);}
 maintain(options={}){const exact=this.exact.maintain(options),associative=this.associative.maintain(options);return {...exact,associative,triggered:exact.triggered||associative.triggered};}
 occupancy(){return Math.max(this.exact.occupancy(),this.associative.occupancy());}peakOccupancy(){return Math.max(this.exact.peakOccupancy(),this.associative.peakOccupancy?.()??this.associative.occupancy());}
 bankBytes(){return this.exact.bankBytes()+(this.associative.bankBytes?.()??this.associative.banks.length*this.associative.cells/2);}
 stats(){const a=this.associative.stats(),e=this.exact.stats();return {engine:'hybrid',banksBytes:this.bankBytes(),metadataBytes:a.metadataBytes??0,exact:e,associative:a,occupancy:this.occupancy(),receipts:e.receipts,writes:this.writes,roles:'exact evidence; associative hints only'};}
 export(){return {format:'hybrid-fact-bank-v1',config:this.config,exact:this.exact.export(),associative:this.associative.export(),writes:this.writes};}static from(s){return new HybridBank(s.config,s);}close(){this.exact.close();this.associative.close?.();}
}
