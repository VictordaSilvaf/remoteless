import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer, type Server} from 'node:http';
import {connect,type Socket} from 'node:net';
import {Pool,withTenant} from '@msm/database';
import {Vault,cryptoReady,randomKey,wipe} from '@msm/crypto';
import {createApp,type Installation} from '../../apps/local-api/src/app.js';
import type {NetworkPolicy} from '../../apps/local-api/src/workspace/network.js';

const runtime=resolve(process.env.MSM_RUNTIME_DIR??'.runtime');
let admin:InstanceType<typeof Pool>,pool:InstanceType<typeof Pool>,app:ReturnType<typeof createApp>,vault:Vault,root:Uint8Array;
let tenant:string,otherTenant:string,installation:Installation,network:NetworkPolicy,group:{id:string;version:number},site:{id:string;version:number};
function application(probeUrl?:string){return createApp({pool,vault,installation,redis:{ping:async()=>'PONG'},testPeer:()=>installation.clientFingerprint,workspaceNetwork:network,...(probeUrl?{proxyProbeUrl:probeUrl}:{})});}
async function post(command:unknown,status=200){const response=await app.inject({method:'POST',url:'/v1/workspace/command',payload:command as object});assert.equal(response.statusCode,status,response.body);return response.json();}
const get=async()=> (await post({kind:'get',limit:100})).snapshot;
const account=(alias:string,extra:object={})=>post({kind:'account.save',alias,groupId:group.id,siteId:site.id,...extra});
const proxy=(port:number,extra:object={})=>post({kind:'proxy.save',groupId:group.id,scheme:'http',host:'8.8.8.8',port,maxAccounts:1,...extra});
const preview=(raw:string,extra:object={})=>post({kind:'import.preview',entity:'accounts',groupId:group.id,siteId:site.id,raw,...extra});
before(async()=>{
  await cryptoReady();const config={host:process.env.MSM_TEST_DB_HOST??'127.0.0.1',port:Number(process.env.MSM_TEST_DB_PORT??15439),database:'multisession',max:3};
  admin=new Pool({...config,user:'postgres',password:(await readFile(`${runtime}/secrets/postgres_password`,'utf8')).trim()});
  pool=new Pool({...config,user:'msm_app',password:(await readFile(`${runtime}/secrets/app_password`,'utf8')).trim()});
});
beforeEach(async()=>{
  tenant=randomUUID();otherTenant=randomUUID();root=randomKey();vault=new Vault();vault.unlock(root);
  network={resolve:async()=>[{address:'8.8.8.8',family:4}]};
  installation={installationId:randomUUID(),tenantId:tenant,clientFingerprint:'workspace-fixture',bootstrapHash:'a'.repeat(64),bootstrapExpiresAt:new Date(Date.now()+60000).toISOString()};
  for(const id of [tenant,otherTenant])await admin.query('INSERT INTO app.tenants(id,name) VALUES($1,$2)',[id,'Phase2 fixture']);
  await admin.query('INSERT INTO app.device_pairings(tenant_id,id,certificate_fingerprint) VALUES($1,$2,$3)',[tenant,installation.installationId,installation.clientFingerprint]);
  app=application();group=(await post({kind:'group.save',name:'Grupo de teste'})).entity;site=(await post({kind:'site.save',name:'Site escolhido',url:'https://8.8.8.8/'})).entity;
});
afterEach(async()=>{
  await app.close();wipe(root);
  for(const table of ['workspace_imports','group_policy_versions','accounts','proxies','secrets','outbox_events','audit_log','vault_verifiers','device_pairings','site_profiles','groups','tenants'])await admin.query(`DELETE FROM app.${table} WHERE ${table==='tenants'?'id':'tenant_id'}=ANY($1::uuid[])`,[[tenant,otherTenant]]);
});
after(async()=>{await pool?.end();await admin?.end();});

test('workspace CRUD protects credentials, optimistic revisions and immutable group policies',async()=>{
  const login='workspace-login-canary',password='workspace-password-canary';
  const created=(await account('Conta ação',{login,password,notes:'Observação Unicode 日本語'})).entity;
  const snapshot=await get();assert.equal(snapshot.total,1);assert.equal(snapshot.accounts[0].hasPassword,true);assert.equal(JSON.stringify(snapshot).includes(password),false);assert.equal(JSON.stringify(snapshot).includes(login),false);
  const stored=(await admin.query('SELECT credential_envelope,login_lookup FROM app.accounts WHERE tenant_id=$1',[tenant])).rows[0];assert.ok(stored.credential_envelope);assert.equal(JSON.stringify(stored).includes(password),false);assert.equal(JSON.stringify(stored).includes(login),false);
  const otherSite=(await post({kind:'site.save',name:'Outro site',url:'https://8.8.4.4/'})).entity;
  assert.equal((await post({kind:'account.save',id:created.id,version:created.version,alias:'Cannot transfer secrets',groupId:group.id,siteId:otherSite.id},409)).error.code,'SITE_CREDENTIAL_REENTRY_REQUIRED');
  const second=(await post({kind:'group.save',name:'Segundo grupo'})).entity;
  const moved=(await account('Conta revisada',{id:created.id,version:created.version,groupId:second.id,enabled:false})).entity;
  const envelope=(await admin.query('SELECT credential_envelope FROM app.accounts WHERE tenant_id=$1 AND id=$2',[tenant,created.id])).rows[0].credential_envelope;
  const opened=vault.open(envelope,{tenantId:tenant,groupId:second.id,entityId:created.id,purpose:'credential'});try{assert.equal(JSON.parse(new TextDecoder().decode(opened)).password,password);}finally{wipe(opened);}
  assert.throws(()=>vault.open(envelope,{tenantId:tenant,groupId:group.id,entityId:created.id,purpose:'credential'}));
  const stale=await post({kind:'account.save',id:created.id,version:1,alias:'stale',groupId:second.id,siteId:site.id},409);assert.equal(stale.error.code,'VERSION_CONFLICT');
  const policy={windowSeconds:120,maxActionsHour:12,maxConcurrency:1};const revised=(await post({kind:'group.save',id:group.id,version:group.version,name:'Grupo revisado',policy})).entity;
  assert.equal(revised.version,2);assert.equal(Number((await admin.query('SELECT count(*) FROM app.group_policy_versions WHERE tenant_id=$1 AND group_id=$2',[tenant,group.id])).rows[0].count),2);
  await assert.rejects(()=>withTenant(pool,tenant,db=>db.query('UPDATE app.group_policy_versions SET policy=$1',[policy])),/permission denied/);
  await post({kind:'account.delete',id:created.id,version:moved.version});assert.equal((await get()).quota.used,0);
  assert.equal((await admin.query('SELECT credential_envelope FROM app.accounts WHERE tenant_id=$1 AND id=$2',[tenant,created.id])).rows[0].credential_envelope,null);
  await post({kind:'group.delete',id:second.id,version:second.version});
});

test('500-row preview/commit handles quoted CSV, duplicates, encryption, replay and concurrent quota admission',async()=>{
  const records=Array.from({length:500},(_,i)=>`"Conta, ação ${i}",csv-user-${i},csv-password-canary,"Observação ${i}"`);
  records[3]='"Duplicada",csv-user-2,csv-password-canary,"Duplicada"';records[4]='"Inválida",,csv-password-canary,"Sem login"';
  const plan=(await preview('alias,login,password,notes\n'+records.join('\n'))).preview;
  assert.equal(plan.rows.length,500);assert.equal(plan.validCount,498);assert.equal(plan.errorCount,2);assert.equal((await get()).total,0);assert.equal(JSON.stringify(plan).includes('csv-password-canary'),false);
  const staged=(await admin.query('SELECT encrypted_rows FROM app.workspace_imports WHERE tenant_id=$1 AND id=$2',[tenant,plan.id])).rows[0].encrypted_rows;assert.equal(JSON.stringify(staged).includes('csv-user-'),false);
  await post({kind:'import.commit',id:plan.id,hash:plan.hash},409);
  const commit=(await post({kind:'import.commit',id:plan.id,hash:plan.hash,acceptPartial:true})).preview;assert.equal(commit.committedIds.length,498);
  const repeated=(await post({kind:'import.commit',id:plan.id,hash:plan.hash,acceptPartial:true})).preview;assert.deepEqual(repeated.committedIds,commit.committedIds);
  assert.equal((await admin.query('SELECT encrypted_rows FROM app.workspace_imports WHERE tenant_id=$1 AND id=$2',[tenant,plan.id])).rows[0].encrypted_rows,null);
  const a=(await preview('login,password\nlast-a1,password\nlast-a2,password')).preview,b=(await preview('login,password\nlast-b1,password\nlast-b2,password')).preview;
  const results=await Promise.all([a,b].map(p=>app.inject({method:'POST',url:'/v1/workspace/command',payload:{kind:'import.commit',id:p.id,hash:p.hash}})));
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);const state=await get();assert.equal(state.quota.used,500);assert.equal(state.total,500);assert.equal(state.accounts.length,100);
  assert.equal(Number((await admin.query('SELECT count(*) FROM app.accounts WHERE tenant_id=$1 AND deleted_at IS NULL',[tenant])).rows[0].count),500);
  const first=state.accounts[0];await post({kind:'account.enabled',id:first.id,version:first.version,enabled:false});
  assert.equal((await get()).quota.used,500);await post({kind:'account.save',alias:'Cannot bypass quota',groupId:group.id,siteId:site.id},409);
});

test('proxy capacity, distribution and rotation stay atomic and reject changes during active sessions',async()=>{
  const p1=(await proxy(8080,{username:'proxy-user-canary',password:'proxy-password-canary'})).entity,p2=(await proxy(8081,{maxAccounts:2})).entity;
  assert.equal((await post({kind:'proxy.save',id:p1.id,version:p1.version,groupId:group.id,scheme:'http',host:'8.8.4.4',port:8080,maxAccounts:1},409)).error.code,'PROXY_AUTH_REENTRY_REQUIRED');
  const a=(await account('Conta A')).entity,b=(await account('Conta B')).entity,c=(await account('Conta C')).entity;
  const assignment=await Promise.all([a,b].map((item,index)=>app.inject({method:'POST',url:'/v1/workspace/command',payload:{kind:'account.save',id:item.id,version:item.version,alias:`Conta ${index}`,groupId:group.id,siteId:site.id,proxyId:p1.id}})));
  assert.deepEqual(assignment.map(r=>r.statusCode).sort(),[200,409]);
  const state=await get(),winner=state.accounts.find((a:any)=>a.proxyId===p1.id),unassigned=state.accounts.filter((a:any)=>!a.proxyId);
  assert.equal((await post({kind:'proxy.distribute',groupId:group.id,accountIds:unassigned.map((a:any)=>a.id)})).assigned,2);
  assert.equal((await post({kind:'proxy.rotate',id:p1.id,version:p1.version},409)).error.code,'PROXY_CAPACITY_EXCEEDED');assert.equal((await get()).accounts.find((a:any)=>a.id===winner.id).proxyId,p1.id);
  const p3=(await proxy(8082)).entity;assert.equal((await post({kind:'proxy.rotate',id:p1.id,version:p1.version})).assigned,1);
  const moved=(await get()).accounts.find((a:any)=>a.id===winner.id);assert.equal(moved.proxyId,p3.id);
  await admin.query("UPDATE app.accounts SET runtime_state='LIVE' WHERE tenant_id=$1 AND id=$2",[tenant,moved.id]);
  assert.equal((await post({kind:'account.save',id:moved.id,version:moved.version,alias:'Busy',groupId:group.id,siteId:site.id,proxyId:p2.id},409)).error.code,'ACCOUNT_BUSY');
  assert.equal((await post({kind:'proxy.save',id:p3.id,version:p3.version,groupId:group.id,scheme:'http',host:'8.8.8.8',port:8082,maxAccounts:1,enabled:false},409)).error.code,'ACCOUNT_BUSY');
  const disabled=(await post({kind:'account.enabled',id:moved.id,version:moved.version,enabled:false})).entity;
  assert.equal((await get()).accounts.find((a:any)=>a.id===moved.id).proxyId,p3.id);
  assert.equal((await post({kind:'account.enabled',id:moved.id,version:disabled.version,enabled:true},409)).error.code,'ACCOUNT_BUSY');
  await admin.query("UPDATE app.accounts SET runtime_state='DORMANT' WHERE tenant_id=$1 AND id=$2",[tenant,moved.id]);
  moved.version=(await post({kind:'account.enabled',id:moved.id,version:disabled.version,enabled:true})).entity.version;
  const other=(await post({kind:'group.save',name:'Outro grupo'})).entity;
  assert.equal((await post({kind:'account.save',id:moved.id,version:moved.version,alias:'Wrong group',groupId:other.id,siteId:site.id,proxyId:p3.id},400)).error.code,'PROXY_GROUP_MISMATCH');
  assert.equal(JSON.stringify(await get()).includes('proxy-password-canary'),false);
});

test('tenant authorization, private URLs and stale import plans fail without creating accounts',async()=>{
  const foreignGroup=randomUUID();await admin.query('INSERT INTO app.groups(tenant_id,id,name) VALUES($1,$2,$3)',[otherTenant,foreignGroup,'Foreign']);
  await post({kind:'account.save',alias:'Foreign',groupId:foreignGroup,siteId:site.id},404);
  await post({kind:'get',tenantId:otherTenant},400);
  for(const url of ['http://127.0.0.1/','http://169.254.169.254/','http://[::1]/'])await post({kind:'site.save',name:'Private',url},400);
  const plan=(await preview('login,password\nstale-user,password')).preview;
  await post({kind:'group.save',id:group.id,version:group.version,name:'Changed group'});
  assert.equal((await post({kind:'import.commit',id:plan.id,hash:plan.hash},409)).error.code,'VERSION_CONFLICT');
  const expired=(await preview('login,password\nexpired-user,password')).preview;
  await admin.query("UPDATE app.workspace_imports SET expires_at=now()-interval '1 hour' WHERE tenant_id=$1 AND id=$2",[tenant,expired.id]);
  assert.equal((await post({kind:'import.commit',id:expired.id,hash:expired.hash},409)).error.code,'IMPORT_EXPIRED');
  const fresh=(await preview('login,password\nfresh-user,password')).preview;await post({kind:'import.commit',id:fresh.id,hash:'0'.repeat(64)},409);
  vault.lock();await post({kind:'import.preview',entity:'accounts',groupId:group.id,siteId:site.id,raw:'login,password\na,b'},423);assert.equal((await get()).quota.used,0);
  assert.equal((await withTenant(pool,tenant,db=>db.query('SELECT 1 FROM app.groups WHERE id=$1',[foreignGroup]))).rowCount,0);
});

test('proxy imports validate each row and keep authentication encrypted',async()=>{
  const raw='scheme,host,port,username,password,max_accounts\nhttp,8.8.8.8,9000,first,proxy-import-password,2\nhttp,8.8.8.8,9000,first,proxy-import-password,2\nsocks5,8.8.4.4,1080,second,proxy-import-password,1\nhttp,127.0.0.1,8080,,,1\nhttp,8.8.8.8,99999,,,1';
  const plan=(await post({kind:'import.preview',entity:'proxies',groupId:group.id,raw})).preview;assert.equal(plan.validCount,2);assert.equal(plan.errorCount,3);
  const result=(await post({kind:'import.commit',id:plan.id,hash:plan.hash,acceptPartial:true})).preview;assert.equal(result.committedIds.length,2);
  const rows=(await admin.query('SELECT auth_envelope,auth_lookup FROM app.proxies WHERE tenant_id=$1',[tenant])).rows;assert.equal(JSON.stringify(rows).includes('proxy-import-password'),false);assert.equal(JSON.stringify(await get()).includes('proxy-import-password'),false);
});
test('proxy import resolves a repeated provider hostname once per preview and commit',async()=>{
  let calls=0;network.resolve=async()=>{calls++;return [{address:'8.8.8.8',family:4}];};
  const raw='scheme,host,port,max_accounts\nhttp,proxy.example,8001,1\nhttp,proxy.example,8002,1\nsocks5,proxy.example,8003,1';
  const plan=(await post({kind:'import.preview',entity:'proxies',groupId:group.id,raw})).preview;
  assert.equal(plan.validCount,3);assert.equal(calls,1);
  await post({kind:'import.commit',id:plan.id,hash:plan.hash});assert.equal(calls,2);
});

test('API proxy checks report real egress and route failure never changes account ban status',async()=>{
  const sockets=new Set<Socket>();let calls=0;const probe=createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.end('{"ip":"203.0.113.21"}');});
  const gateway=createServer();const servers:Server[]=[probe,gateway];
  for(const server of servers)server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});});
  const listen=(server:Server)=>new Promise<number>(done=>server.listen(0,'127.0.0.1',()=>done((server.address() as {port:number}).port)));
  try {
    const port=await listen(probe);gateway.on('connect',(_req,socket,head)=>{const upstream=connect({host:'127.0.0.1',port});sockets.add(upstream);upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});socket.once('close',()=>upstream.destroy());});
    const gatewayPort=await listen(gateway);await app.close();vault.unlock(root);network.allowPrivate=true;app=application(`http://probe.test:${port}/ip`);
    const p=(await post({kind:'proxy.save',groupId:group.id,scheme:'http',host:'127.0.0.1',port:gatewayPort,maxAccounts:1})).entity;
    const a=(await account('Conta com proxy',{proxyId:p.id})).entity;
    const good=await post({kind:'proxy.test',id:p.id,version:p.version});assert.equal(good.check.state,'HEALTHY');assert.equal(good.check.egressIp,'203.0.113.21');assert.equal(calls,1);
    for(const socket of sockets)socket.destroy();await new Promise<void>(done=>gateway.close(()=>done()));
    const bad=await post({kind:'proxy.test',id:p.id,version:p.version});assert.equal(bad.check.state,'UNAVAILABLE');assert.equal(calls,1);
    const snapshot=await get();assert.equal(snapshot.proxies[0].state,'UNAVAILABLE');assert.equal(snapshot.accounts.find((row:any)=>row.id===a.id).state,'UNKNOWN');
  }finally{for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise<void>(done=>server.close(()=>done()))));}
});
