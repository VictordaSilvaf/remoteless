import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from '@msm/database';
import {EngineService,type Lease} from '../../apps/local-api/src/engine/service.js';

// Verification subprocess only. The lease arrives through private IPC, never argv/logs.
process.once('message',async(input:{tenantId:string;actorId:string;now:number;lease:Lease;origin:string;stage:'before-effect'|'after-effect'})=>{
  const directory=resolve(process.env.MSM_RUNTIME_DIR??'.runtime');
  const pool=new Pool({host:process.env.MSM_TEST_DB_HOST??'127.0.0.1',port:Number(process.env.MSM_TEST_DB_PORT??15439),database:'multisession',user:'msm_app',password:(await readFile(`${directory}/secrets/app_password`,'utf8')).trim(),max:1});
  try {
    const engine=new EngineService({pool,tenantId:input.tenantId,actorId:input.actorId,adapters:new Map(),now:()=>input.now});
    await engine.start(input.lease);
    if(input.stage==='after-effect'){await engine.beforeEffect(input.lease);await fetch(`${input.origin}/effect/${input.lease.actionId}`,{method:'POST'});}
    process.send?.({ready:true});setInterval(()=>{},1000);
  }catch{process.send?.({ready:false});await pool.end();process.exitCode=1;process.disconnect?.();}
});
