/** Bank choice is independent of SOP syntax, temporal semantics and reasoner.
 * Canonical `memory.engine` names are listed in MEMORY_ENGINES. The legacy identifiers
 * `weaver` (RecallMemory, DS016) and `holo` (HoloMemory, DS017) stay accepted so that
 * existing configurations and persisted snapshots keep loading.
 */
import {HybridBank} from './hybrid.mjs';
import {RecallMemory} from '../weaver.mjs';
import {HoloBank,HOLO_FORMATS} from './holo.mjs';
import {SQLiteBank} from './sqlite.mjs';
import {ScanBank} from './scan.mjs';
export const MEMORY_ENGINES=['recall-memory','holo-memory','sqlite','scan','hybrid'];
export const ENGINE_ALIASES={weaver:'recall-memory',holo:'holo-memory'};
export const canonicalEngine=name=>ENGINE_ALIASES[name]??name;
export function bankEngine(stateOrConfig={}){
 if(stateOrConfig.format==='hybrid-fact-bank-v1')return 'hybrid';
 if(HOLO_FORMATS.includes(stateOrConfig.format))return 'holo-memory';
 if(stateOrConfig.format==='sqlite-fact-bank-v1')return 'sqlite';
 if(stateOrConfig.format==='scan-fact-bank-v1')return 'scan';
 return canonicalEngine((stateOrConfig.config??stateOrConfig).engine??'recall-memory');
}
export function createBank(config={},state=null){
 const engine=bankEngine(state??config),C={'recall-memory':RecallMemory,'holo-memory':HoloBank,sqlite:SQLiteBank,scan:ScanBank,hybrid:HybridBank}[engine];
 if(!C)throw Error('Unknown memory.engine '+engine+' (expected one of '+MEMORY_ENGINES.join(', ')+')');
 return state?C.from(state):new C(config);
}
export const bankBytes=bank=>typeof bank.bankBytes==='function'?bank.bankBytes():bank.banks.length*bank.cells/2;
