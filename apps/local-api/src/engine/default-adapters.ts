import {withTenant,type Pool} from '@msm/database';
import {wipe,type Vault} from '@msm/crypto';
import {checkProxy,type ProxyEndpoint} from '../workspace/proxy-check.js';
import type {NetworkPolicy} from '../workspace/network.js';
import type {AdapterRegistry,EngineAdapter} from './adapters.js';

export function defaultAdapters(deps:{pool:InstanceType<typeof Pool>;tenantId:string;vault:Vault;network?:NetworkPolicy;probeUrl?:string}):AdapterRegistry {
  const inspect:EngineAdapter={kind:'account.inspect',version:'registry-v1',estimatedSeconds:1,replaySafe:true,
    execute:async context=>{
      await context.beforeEffect();context.signal.throwIfAborted();
      const present=await withTenant(deps.pool,deps.tenantId,async db=>(await db.query('SELECT 1 FROM app.accounts WHERE id=$1 AND deleted_at IS NULL AND enabled',[context.accountId])).rowCount===1);
      return present?{kind:'SUCCEEDED',evidence:{code:'REGISTRY_PRESENT'}}:{kind:'FAILED',code:'ACCOUNT_UNAVAILABLE'};
    },
    // The interrupted read itself has no business effect; repeat is safe, not a fabricated success.
    reconcile:async()=> 'NOT_APPLIED',fenceAndBaseline:async()=> 'registry-read-only-v1',
  };
  const probe:EngineAdapter={kind:'proxy.probe',version:'proxy-read-v1',estimatedSeconds:10,replaySafe:true,
    execute:async context=>{
      if(!deps.vault.unlocked)return {kind:'SAFE_RETRY',code:'VAULT_LOCKED',retryAfterSeconds:20};
      const proxy=await withTenant(deps.pool,deps.tenantId,async db=>(await db.query('SELECT * FROM app.proxies WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL AND enabled',[context.proxyId,context.groupId])).rows[0]);
      if(!proxy)return {kind:'FAILED',code:'PROXY_UNAVAILABLE'};
      const endpoint:ProxyEndpoint={scheme:proxy.scheme,host:proxy.host,port:proxy.port};
      if(proxy.auth_envelope){const bytes=deps.vault.open(proxy.auth_envelope,{tenantId:deps.tenantId,groupId:context.groupId,entityId:proxy.id,purpose:'proxy'});try{Object.assign(endpoint,JSON.parse(new TextDecoder().decode(bytes)));}finally{wipe(bytes);}}
      await context.beforeEffect();context.signal.throwIfAborted();
      const result=await checkProxy(endpoint,deps.probeUrl??'https://api64.ipify.org?format=json',deps.network);
      context.signal.throwIfAborted();
      await withTenant(deps.pool,deps.tenantId,db=>db.query('UPDATE app.proxies SET state=$3,observed_egress_ip=$4,latency_ms=$5,checked_at=now(),error_code=$6 WHERE id=$1 AND version=$2',[proxy.id,proxy.version,result.state,result.egressIp,result.latencyMs,result.errorCode]));
      return result.state==='HEALTHY'?{kind:'SUCCEEDED',evidence:{code:'PROXY_EGRESS_VERIFIED'}}:{kind:'FAILED',code:'PROXY_UNAVAILABLE'};
    },reconcile:async()=> 'NOT_APPLIED',fenceAndBaseline:async()=> 'proxy-read-only-v1',
  };
  return new Map([[inspect.kind,inspect],[probe.kind,probe]]);
}
