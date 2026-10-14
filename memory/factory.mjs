import {TemporalLayer} from './temporal.mjs';
import {ShardedLayer} from './sharded.mjs';
export function createLayer(config={},state=null){
 if(state?.format==='sharded-v1'||(!state&&config.sharding?.enabled))return new ShardedLayer(config,state);
 return new TemporalLayer(config,state);
}
export function knowledgeConfig(config={}){
 // A shared reviewed KB is never automatically sacrificed to a user's cache.
 return config.sharding?.enabled?{...config,sharding:{...config.sharding,mode:'archive'}}:config;
}
