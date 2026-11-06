import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import {fork} from 'node:child_process';
import {Queue} from 'bullmq';
import {Pool,withTenant} from '@msm/database';
import {Vault,cryptoReady} from '@msm/crypto';
import {createApp,type Installation} from '../../apps/local-api/src/app.js';
import {EngineService,type Lease} from '../../apps/local-api/src/engine/service.js';
import {EngineRuntime} from '../../apps/local-api/src/engine/runtime.js';
import type {AdapterRegistry,EngineAdapter} from '../../apps/local-api/src/engine/adapters.js';
import type {EngineSnapshot,ExecutionPlan} from '@msm/contracts';

const runtime=resolve(process.env.MSM_RUNTIME_DIR??'.runtime');
let admin:InstanceType<typeof Pool>,pool:InstanceType<typeof Pool>,app:ReturnType<typeof createApp>,engine:EngineService,tenant:string,foreign:string,installation:Installation;
let group:string,group2:string,site:string,accounts:string[],now:number,adapter:EngineAdapter,adapters:AdapterRegistry,server:Server,origin:string;
let receipts:Map<string,number>,effects:number,reconciliation:'receipt'|'absent'|'unknown',allowBaseline:boolean,executionRuntime:EngineRuntime|undefined;
let redisConnection:{host:string;port:number;password:string;connectTimeout:number};
const owner=randomUUID();
async function post(command:unknown,status=200){const response=await app.inject({method:'POST',url:'/v1/engine/command',payload:command as object});assert.equal(response.statusCode,status,response.body);return response.json();}
async function get():Promise<EngineSnapshot>{return (await post({kind:'get',limit:100})).snapshot;}
async function recipe(steps=2){return (await post({kind:'recipe.save',name:'Receita fixture',steps:Array.from({length:steps},()=>({kind:'account.inspect'}))})).recipe;}
async function preview(ids=accounts,steps=2,options:object={}):Promise<ExecutionPlan>{const r=await recipe(steps);return (await post({kind:'plan.preview',recipeId:r.id,recipeVersion:r.version,accountIds:ids,mode:'immediate',acknowledgeImmediate:true,...options})).plan;}
async function confirm(plan:ExecutionPlan,key=randomUUID()){return (await post({kind:'plan.confirm',id:plan.id,hash:plan.hash,token:plan.token,idempotencyKey:key})).campaignId as string;}
async function ready(){now+=3000;await engine.tick();return engine.tickets();}
async function claim(actionId?:string):Promise<Lease>{const events=await engine.tickets(),event=actionId?events.find(t=>t.entity_id===actionId):events[0];assert.ok(event);const lease=await engine.claim(event.id,event.entity_id,owner);assert.ok(lease);return lease;}
async function send(lease:Lease){await engine.start(lease);await engine.beforeEffect(lease);await fetch(`${origin}/effect/${lease.actionId}`,{method:'POST'});}
async function crashWorker(lease:Lease,stage:'before-effect'|'after-effect'){
  const child=fork('scripts/dist/engine-crash-worker.js',[],{stdio:['ignore','ignore','ignore','ipc'],env:process.env});
  try{await new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error('CRASH_WORKER_TIMEOUT')),10000);child.once('message',(value:{ready:boolean})=>{clearTimeout(timer);value.ready?done():reject(Error('CRASH_WORKER_FAILED'));});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('CRASH_WORKER_EXITED'));});child.send({tenantId:tenant,actorId:installation.installationId,now,lease,origin,stage});});}
  finally{const ended=new Promise(done=>child.once('exit',done));child.kill('SIGKILL');await ended;}
}
async function until(check:()=>Promise<boolean>){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,50));}throw Error('ENGINE_TEST_TIMEOUT');}
function freshEngine(){return new EngineService({pool,tenantId:tenant,actorId:installation.installationId,adapters,now:()=>now});}
before(async()=>{
  await cryptoReady();const config={host:process.env.MSM_TEST_DB_HOST??'127.0.0.1',port:Number(process.env.MSM_TEST_DB_PORT??15439),database:'multisession',max:5};
  admin=new Pool({...config,user:'postgres',password:(await readFile(`${runtime}/secrets/postgres_password`,'utf8')).trim()});pool=new Pool({...config,user:'msm_app',password:(await readFile(`${runtime}/secrets/app_password`,'utf8')).trim()});
  redisConnection={host:process.env.MSM_TEST_REDIS_HOST??'127.0.0.1',port:Number(process.env.MSM_TEST_REDIS_PORT??16379),password:(await readFile(`${runtime}/secrets/redis_password`,'utf8')).trim(),connectTimeout:3000};
});
beforeEach(async()=>{
  now=Date.now();tenant=randomUUID();foreign=randomUUID();group=randomUUID();group2=randomUUID();site=randomUUID();accounts=[randomUUID(),randomUUID()];receipts=new Map();effects=0;reconciliation='receipt';allowBaseline=false;
  server=createServer((req,res)=>{const id=req.url!.split('/').at(-1)!;if(req.method==='POST'){effects++;receipts.set(id,(receipts.get(id)??0)+1);res.end('ok');}else{res.setHeader('content-type','application/json');res.end(JSON.stringify({count:receipts.get(id)??0}));}});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  adapter={kind:'account.inspect',version:'mutable-fixture-v1',estimatedSeconds:1,replaySafe:false,
    execute:async c=>{await c.beforeEffect();c.signal.throwIfAborted();await fetch(`${origin}/effect/${c.actionId}`,{method:'POST'});return {kind:'SUCCEEDED',evidence:{code:'FIXTURE_RECEIPT'}};},
    reconcile:async c=>{if(reconciliation==='unknown')return 'UNKNOWN';if(reconciliation==='absent')return 'NOT_APPLIED';const receipt=await (await fetch(`${origin}/receipt/${c.actionId}`)).json() as {count:number};return receipt.count?'SUCCEEDED':'UNKNOWN';},
    fenceAndBaseline:async()=>allowBaseline?'fixture-fenced-baseline':null,
  };adapters=new Map([[adapter.kind,adapter]]);
  installation={installationId:randomUUID(),tenantId:tenant,clientFingerprint:'phase3-fixture',bootstrapHash:'a'.repeat(64),bootstrapExpiresAt:new Date(now+60000).toISOString()};
  for(const id of [tenant,foreign])await admin.query('INSERT INTO app.tenants(id,name) VALUES($1,$2)',[id,'Phase3 isolated fixture']);
  for(const id of [group,group2])await admin.query('INSERT INTO app.groups(tenant_id,id,name) VALUES($1,$2,$3)',[tenant,id,id]);
  await admin.query('INSERT INTO app.site_profiles(tenant_id,id,name,start_url) VALUES($1,$2,$3,$4)',[tenant,site,'Chosen fixture','https://example.org/']);
  for(const id of accounts)await admin.query('INSERT INTO app.accounts(tenant_id,id,group_id,site_id,alias) VALUES($1,$2,$3,$4,$5)',[tenant,id,group,site,id]);
  await admin.query('INSERT INTO app.device_pairings(tenant_id,id,certificate_fingerprint) VALUES($1,$2,$3)',[tenant,installation.installationId,installation.clientFingerprint]);
  app=createApp({pool,vault:new Vault(),installation,redis:{ping:async()=>'PONG'},testPeer:()=>installation.clientFingerprint,engineAdapters:adapters,engineNow:()=>now});engine=app.executionEngine;
});
afterEach(async()=>{
  await executionRuntime?.close();executionRuntime=undefined;
  const queue=new Queue(`msm-actions-${tenant}`,{connection:redisConnection});await queue.obliterate({force:true});await queue.close();
  await app?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
  // Break self references before deleting the tenant's isolated fixture history.
  await admin.query('UPDATE app.action_intents SET previous_execution_id=NULL,depends_on_id=NULL WHERE tenant_id=$1',[tenant]);
  await admin.query('UPDATE app.execution_heads SET current_action_id=NULL,last_action_id=NULL WHERE tenant_id=$1',[tenant]);
  for(const table of ['quota_reservations','action_transitions','action_attempts','action_intents','execution_heads','campaigns','execution_plans','recipe_versions','recipes','accounts','device_pairings','audit_log','outbox_events','proxies','site_profiles','groups','tenants'])await admin.query(`DELETE FROM app.${table} WHERE ${table==='tenants'?'id':'tenant_id'}=ANY($1::uuid[])`,[[tenant,foreign]]);
});
after(async()=>{await pool?.end();await admin?.end();});

test('dry-run has no effects; confirmation is bound, atomic and idempotent under concurrency',async()=>{
  const plan=await preview();assert.equal(plan.actions,4);assert.equal(effects,0);assert.equal((await get()).campaigns.length,0);
  const raw={kind:'plan.confirm',id:plan.id,hash:plan.hash,token:plan.token,idempotencyKey:randomUUID()};
  assert.equal((await post({...raw,token:'invalid-token'.repeat(4)},403)).error.code,'PLAN_CONFIRMATION_REJECTED');
  const results=await Promise.all([post(raw),post(raw)]);assert.equal(results[0].campaignId,results[1].campaignId);assert.equal((await get()).actions.length,4);
  assert.equal((await post({...raw,idempotencyKey:randomUUID()},409)).error.code,'PLAN_ALREADY_CONSUMED');
  const stored=(await admin.query('SELECT token_hash,snapshot FROM app.execution_plans WHERE tenant_id=$1',[tenant])).rows[0];assert.notEqual(stored.token_hash,plan.token);assert.equal(JSON.stringify(stored).includes(plan.token),false);
  await assert.rejects(()=>withTenant(pool,tenant,db=>db.query('UPDATE app.recipe_versions SET steps=$1',['[]'])),/permission denied/);
});
test('stale/expired plans, unsupported effects and immediate mode without acknowledgement are rejected',async()=>{
  const r=await recipe(1);await post({kind:'plan.preview',recipeId:r.id,recipeVersion:1,accountIds:accounts,mode:'immediate'},400);
  const stale=await preview();await admin.query('UPDATE app.accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2',[tenant,accounts[0]]);
  assert.equal((await post({kind:'plan.confirm',id:stale.id,hash:stale.hash,token:stale.token,idempotencyKey:randomUUID()},409)).error.code,'PLAN_STALE');
  const expired=await preview();now+=301000;assert.equal((await post({kind:'plan.confirm',id:expired.id,hash:expired.hash,token:expired.token,idempotencyKey:randomUUID()},409)).error.code,'PLAN_EXPIRED');
  await post({kind:'recipe.save',name:'unsafe',steps:[{kind:'eval',code:'secret'}]},400);assert.equal(effects,0);
});
test('strict predecessors, per-account leases, cross-campaign FIFO and duplicate tickets prevent duplicate effects',async()=>{
  const firstCampaign=await confirm(await preview([accounts[0]!],2));await confirm(await preview([accounts[0]!],1));await ready();
  const actions=(await get()).actions.filter(a=>a.campaignId===firstCampaign),first=actions.find(a=>a.step===0)!,second=actions.find(a=>a.step===1)!;
  const events=await engine.tickets(),event=events.find(e=>e.entity_id===first.id)!;
  const claims=await Promise.all([engine.claim(event.id,first.id,owner),engine.claim(event.id,first.id,randomUUID())]);assert.equal(claims.filter(Boolean).length,1);
  assert.equal(await engine.claim(event.id,second.id,owner),null);
  const lease=claims.find(Boolean)!;await send(lease);await engine.finish(lease,{kind:'SUCCEEDED'});assert.equal(effects,1);
  now+=3000;await engine.tick();const next=await claim(second.id);await send(next);await engine.finish(next,{kind:'SUCCEEDED'});
  now+=3000;await engine.tick();const last=await claim();await send(last);await engine.finish(last,{kind:'SUCCEEDED'});assert.equal(effects,3);
  assert.equal(await engine.claim(event.id,first.id,owner),null);
  const rows=(await admin.query('SELECT dispatch_seq,previous_execution_id FROM app.action_intents WHERE tenant_id=$1 ORDER BY dispatch_seq',[tenant])).rows;assert.deepEqual(rows.map(r=>Number(r.dispatch_seq)),[1,2,3]);assert.equal(rows[1].previous_execution_id,first.id);
});
test('a failed step blocks successors and other campaigns until explicit audited chain reset',async()=>{
  await confirm(await preview([accounts[0]!],2));await ready();const lease=await claim();await engine.start(lease);await engine.finish(lease,{kind:'FAILED',code:'PRECONDITION_REJECTED'});await engine.tick();
  assert.deepEqual((await get()).actions.map(a=>a.state).sort(),['CANCELLED','FAILED']);assert.equal(effects,0);
  const excluded=await preview([accounts[0]!],1);assert.equal(excluded.eligible,0);assert.equal(excluded.targets[0]!.reason,'CHAIN_BLOCKED');
  await post({kind:'chain.reset',accountId:accounts[0],epoch:1,reason:'Inspecionada a falha antes do efeito'});
  assert.equal((await preview([accounts[0]!],1)).eligible,1);
  assert.equal(Number((await admin.query("SELECT count(*) FROM app.audit_log WHERE tenant_id=$1 AND verb='engine.chain.reset'",[tenant])).rows[0].count),1);
});
test('crash before effect intent permits bounded safe retry and fences the old owner',async()=>{
  await confirm(await preview([accounts[0]!],1));await ready();const lease=await claim();await crashWorker(lease,'before-effect');now+=31000;engine=freshEngine();await engine.tick();
  assert.equal((await get()).actions[0]!.state,'RETRY_WAIT');await assert.rejects(()=>engine.beforeEffect(lease),/LEASE_FENCED/);assert.equal(effects,0);
  for(let attempt=2;attempt<=3;attempt++){now+=25000;await engine.tick();const next=await claim();assert.equal(next.attempt,attempt);await engine.start(next);await engine.finish(next,{kind:'SAFE_RETRY',code:'NO_EFFECT_SENT'});}
  assert.equal((await get()).actions[0]!.state,'FAILED');assert.equal(Number((await admin.query('SELECT count(*) FROM app.action_attempts WHERE tenant_id=$1',[tenant])).rows[0].count),3);
});
test('crash after a mutable effect reconciles the receipt without replay and releases the chain',async()=>{
  await confirm(await preview([accounts[0]!],2));await ready();const lease=await claim();await crashWorker(lease,'after-effect');assert.equal(effects,1);
  now+=31000;engine=freshEngine();const candidates=await engine.tick();assert.equal(candidates[0],lease.actionId);
  await assert.rejects(()=>engine.finish(lease,{kind:'SUCCEEDED'}),/LEASE_FENCED/);await engine.reconcile(lease.actionId);await engine.tick();
  const next=await claim();await send(next);await engine.finish(next,{kind:'SUCCEEDED'});assert.equal(effects,2);assert.equal(receipts.get(lease.actionId),1);assert.equal((await get()).campaigns[0]!.state,'SUCCEEDED');
});
test('uncertain mutable effects block retries and abandonment until a fenced baseline is available',async()=>{
  await confirm(await preview([accounts[0]!],2));await ready();const lease=await claim();await send(lease);reconciliation='unknown';await engine.finish(lease,{kind:'SAFE_RETRY',code:'RESPONSE_LOST'});await engine.reconcile(lease.actionId);await engine.tick();
  let snapshot=await get();assert.equal(snapshot.actions.find(a=>a.id===lease.actionId)!.state,'UNKNOWN');assert.equal(snapshot.campaigns[0]!.state,'BLOCKED');assert.equal(snapshot.actions.find(a=>a.step===1)!.state,'WAITING_PREDECESSOR');
  await post({kind:'chain.reset',accountId:accounts[0],epoch:1,reason:'Sem evidência suficiente para reiniciar'},409);assert.equal(effects,1);
  now+=120000;await engine.tick();assert.equal(effects,1);assert.equal((await engine.tickets()).length,0);
  allowBaseline=true;await post({kind:'chain.reset',accountId:accounts[0],epoch:1,reason:'Runner antigo cercado e baseline inspecionado'});snapshot=await get();assert.deepEqual(snapshot.actions.map(a=>a.state).sort(),['ABANDONED','CANCELLED']);assert.equal((await preview([accounts[0]!],1)).eligible,1);
});
test('cancellation closes admission; an already sent effect is verified and successors never start',async()=>{
  const id=await confirm(await preview([accounts[0]!],2));await ready();const lease=await claim();await send(lease);const campaign=(await get()).campaigns[0]!;
  await post({kind:'campaign.cancel',id,version:campaign.version});await engine.finish(lease,{kind:'SUCCEEDED'});await engine.tick();
  const snapshot=await get();assert.equal(snapshot.actions.find(a=>a.id===lease.actionId)!.state,'SUCCEEDED');assert.equal(snapshot.actions.find(a=>a.step===1)!.state,'CANCELLED');assert.equal(snapshot.campaigns[0]!.state,'PARTIAL');assert.equal(effects,1);
  const p=await preview([accounts[1]!],1);const cancelled=await confirm(p);const c=(await get()).campaigns.find(c=>c.id===cancelled)!;await post({kind:'campaign.cancel',id:cancelled,version:c.version});await ready();assert.equal((await engine.tickets()).length,0);
});
test('late work expires without burst catch-up and action cancellation is a durable guard',async()=>{
  await confirm(await preview([accounts[0]!],2,{windowSeconds:60}));now+=63000;await engine.tick();assert.ok((await get()).actions.every(a=>a.state==='EXPIRED'));assert.equal(effects,0);
  await confirm(await preview([accounts[1]!],1));await ready();const action=(await get()).actions.find(a=>a.accountId===accounts[1])!;await post({kind:'action.cancel',id:action.id,version:action.version});assert.equal((await engine.tickets()).length,0);
});
test('durable group quotas and concurrency are rechecked at admission under concurrent consumers',async()=>{
  await confirm(await preview(accounts,1));await ready();await admin.query('UPDATE app.groups SET policy=jsonb_set(policy,\'{maxConcurrency}\',\'1\') WHERE tenant_id=$1 AND id=$2',[tenant,group]);
  const events=await engine.tickets(),claims=await Promise.all(events.map(e=>engine.claim(e.id,e.entity_id,randomUUID())));assert.equal(claims.filter(Boolean).length,1);
  const first=claims.find(Boolean)!;await send(first);await engine.finish(first,{kind:'SUCCEEDED'});
  // Current quota usage wins over the preview. The other account is deferred, without a new effect.
  await admin.query('UPDATE app.groups SET policy=jsonb_set(policy,\'{maxActionsHour}\',\'1\') WHERE tenant_id=$1 AND id=$2',[tenant,group]);
  now+=2000;await engine.tick();const event=(await engine.tickets())[0]!;assert.equal(await engine.claim(event.id,event.entity_id,owner),null);assert.equal((await get()).actions.find(a=>a.id===event.entity_id)!.reason,'HOURLY_QUOTA');assert.equal(effects,1);
});

test('accounts sharing a proxy use one execution slot and persist the route quota',async()=>{
  const proxy=randomUUID();await admin.query("INSERT INTO app.proxies(tenant_id,id,group_id,scheme,host,port,auth_lookup,max_accounts) VALUES($1,$2,$3,'http','8.8.8.8',8080,'fixture-route',2)",[tenant,proxy,group]);
  await admin.query('UPDATE app.accounts SET proxy_id=$2 WHERE tenant_id=$1',[tenant,proxy]);
  await confirm(await preview(accounts,1));const events=await ready();
  const leases=await Promise.all(events.map(e=>engine.claim(e.id,e.entity_id,randomUUID())));assert.equal(leases.filter(Boolean).length,1);
  const first=leases.find(Boolean)!;await send(first);await engine.finish(first,{kind:'SUCCEEDED'});
  const quota=(await admin.query("SELECT scope_id,committed_at FROM app.quota_reservations WHERE tenant_id=$1 AND scope_kind='proxy'",[tenant])).rows;assert.equal(quota.length,1);assert.equal(quota[0].scope_id,proxy);assert.ok(quota[0].committed_at);
  now+=2000;await engine.tick();const next=await claim();await send(next);await engine.finish(next,{kind:'SUCCEEDED'});assert.equal(effects,2);
});
test('registry changes and emergency disabling between leasing and sending prevent an external effect',async()=>{
  await confirm(await preview([accounts[0]!],1));await ready();const lease=await claim();await engine.start(lease);
  const result=await app.inject({method:'POST',url:'/v1/workspace/command',payload:{kind:'account.enabled',id:accounts[0],version:1,enabled:false}});assert.equal(result.statusCode,200,result.body);
  await assert.rejects(()=>engine.beforeEffect(lease),/CANCEL_REQUESTED/);await engine.finish(lease,{kind:'FAILED',code:'ACCOUNT_DISABLED'});assert.equal(effects,0);
});
test('tenant RLS, append-only history and predecessor constraints protect the execution ledger',async()=>{
  await confirm(await preview([accounts[0]!],2));
  assert.equal((await withTenant(pool,foreign,db=>db.query('SELECT * FROM app.campaigns'))).rowCount,0);
  await post({kind:'get',tenantId:foreign},400);
  await assert.rejects(()=>withTenant(pool,tenant,db=>db.query('UPDATE app.action_transitions SET reason=$1',['erased'])),/permission denied/);
  const actions=(await get()).actions;await assert.rejects(()=>withTenant(pool,tenant,db=>db.query('UPDATE app.action_intents SET depends_on_id=$2 WHERE id=$1',[actions.find(a=>a.step===0)!.id,actions.find(a=>a.step===1)!.id])),/INVALID_RECIPE_PREDECESSOR/);
});
test('real BullMQ recovers an acknowledged but lost Redis queue from PostgreSQL and deduplicates effects',async()=>{
  await confirm(await preview([accounts[0]!],1));const events=await ready(),event=events[0]!;
  const queue=new Queue(`msm-actions-${tenant}`,{connection:redisConnection});await queue.add('action',{version:1,eventId:event.id,actionId:event.entity_id},{jobId:event.id});await engine.published(event.id);
  // Delete only this test tenant's queue. All source-of-truth rows remain intact.
  await queue.obliterate({force:true});await queue.close();now+=11000;
  engine=freshEngine();executionRuntime=new EngineRuntime(engine,redisConnection);executionRuntime.start();
  await until(async()=> (await get()).actions[0]!.state==='SUCCEEDED');assert.equal(effects,1);
  await engine.tick();await executionRuntime.cycle();assert.equal(effects,1);
});

test('an idle blocking consumer still accepts work when the producer has a short command timeout',async()=>{
  executionRuntime=new EngineRuntime(engine,{...redisConnection,commandTimeout:300});executionRuntime.start();
  await new Promise(done=>setTimeout(done,900));
  await confirm(await preview([accounts[0]!],1));now+=3000;
  await until(async()=> (await get()).actions[0]!.state==='SUCCEEDED');assert.equal(effects,1);assert.equal(engine.runtime.available,true);
});

test('a failed transport delivery is recoverable even when the first database recovery write is lost',async()=>{
  await confirm(await preview([accounts[0]!],1));await ready();
  const originalClaim=engine.claim.bind(engine),originalRecovery=engine.deliveryFailed.bind(engine);let failClaim=true,failRecovery=true;
  engine.claim=async(...args)=>{if(failClaim){failClaim=false;throw Error('INJECTED_DATABASE_UNAVAILABLE');}return originalClaim(...args);};
  engine.deliveryFailed=async(...args)=>{if(failRecovery){failRecovery=false;throw Error('INJECTED_DATABASE_UNAVAILABLE');}return originalRecovery(...args);};
  executionRuntime=new EngineRuntime(engine,redisConnection);executionRuntime.start();
  const queue=new Queue(`msm-actions-${tenant}`,{connection:redisConnection});
  try{
    await until(async()=> (await queue.getFailedCount())===1);assert.equal((await get()).actions[0]!.state,'READY');assert.equal(effects,0);
    now+=11000;await executionRuntime.cycle();await until(async()=> (await get()).actions[0]!.state==='SUCCEEDED');assert.equal(effects,1);assert.equal((await get()).actions[0]!.attempts,1);
  }finally{await queue.close();}
});
