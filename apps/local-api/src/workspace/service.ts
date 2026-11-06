import {createHash,randomUUID} from 'node:crypto';
import {withTenant,type Pool,type PoolClient} from '@msm/database';
import {Vault,wipe} from '@msm/crypto';
import {workspaceCommandSchema,type ParsedWorkspaceCommand,type WorkspaceResult,type WorkspaceSnapshot,type ImportPreview,type ImportRow,type Ciphertext,defaultGroupPolicy} from '@msm/contracts';
import {WorkspaceError} from './errors.js';
import {siteUrl,resolvePublic,canonicalHost,type NetworkPolicy} from './network.js';
import {importRecords} from './csv.js';
import {checkProxy,type ProxyEndpoint} from './proxy-check.js';

// Database rows stay private. Every response is constructed from an explicit field list.
type Row=Record<string,any>;
type HostCache=Map<string,ReturnType<typeof resolvePublic>>;
type Save<K extends ParsedWorkspaceCommand['kind']>=Extract<ParsedWorkspaceCommand,{kind:K}>;
interface Dependencies {pool:InstanceType<typeof Pool>;vault:Vault;tenantId:string;actorId:string;maxAccounts?:number;network?:NetworkPolicy;probeUrl?:string;}
export class WorkspaceService {
  readonly limit:number;
  constructor(private readonly deps:Dependencies){this.limit=deps.maxAccounts??500;if(!Number.isInteger(this.limit)||this.limit<1||this.limit>500)throw Error('INVALID_ACCOUNT_LIMIT');}
  private async tx<T>(work:(db:PoolClient)=>Promise<T>){
    try{return await withTenant(this.deps.pool,this.deps.tenantId,async db=>{await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`workspace:${this.deps.tenantId}`]);return work(db);});}
    catch(error){const code=(error as {code?:string}).code;if(code==='23505')throw new WorkspaceError('DUPLICATE_ENTRY');if(code==='23503')throw new WorkspaceError('INVALID_REFERENCE',400);if(code==='23514')throw new WorkspaceError('INVALID_VALUE',400);throw error;}
  }
  private requireVault(){if(!this.deps.vault.unlocked)throw new WorkspaceError('VAULT_LOCKED',423);}
  private scope(groupId:string,entityId:string,purpose:'credential'|'proxy'){return {tenantId:this.deps.tenantId,groupId,entityId,purpose};}
  private seal(value:unknown,groupId:string,id:string,purpose:'credential'|'proxy'){
    this.requireVault();const bytes=new TextEncoder().encode(JSON.stringify(value));
    try{return this.deps.vault.seal(bytes,this.scope(groupId,id,purpose));}finally{wipe(bytes);}
  }
  private open(envelope:Ciphertext,groupId:string,id:string,purpose:'credential'|'proxy'){
    this.requireVault();const bytes=this.deps.vault.open(envelope,this.scope(groupId,id,purpose));
    try{return JSON.parse(new TextDecoder().decode(bytes)) as Row;}finally{wipe(bytes);}
  }
  private async row(db:PoolClient,table:'groups'|'site_profiles'|'accounts'|'proxies',id:string,version?:number){
    const row=(await db.query(`SELECT * FROM app.${table} WHERE id=$1 AND deleted_at IS NULL`,[id])).rows[0] as Row|undefined;
    if(!row)throw new WorkspaceError('NOT_FOUND',404);
    if(version!==undefined&&row.version!==version)throw new WorkspaceError('VERSION_CONFLICT');
    return row;
  }
  private mutable(account:Row){if(account.runtime_state!=='DORMANT')throw new WorkspaceError('ACCOUNT_BUSY');}
  private async audit(db:PoolClient,verb:string,targetId:string,requestId:string){await db.query('INSERT INTO app.audit_log(tenant_id,id,actor_id,verb,target_id,request_id) VALUES($1,$2,$3,$4,$5,$6)',[this.deps.tenantId,randomUUID(),this.deps.actorId,verb,targetId,requestId]);}
  private resolveHost(raw:string,cache?:HostCache){const host=canonicalHost(raw);return cache?.get(host)??resolvePublic(host,this.deps.network);}
  private async warmHosts(raw:string[]):Promise<HostCache>{
    const hosts=[...new Set(raw.flatMap(value=>{try{return [canonicalHost(value)];}catch{return [];}}))],cache:HostCache=new Map();
    let cursor=0;const deadline=Date.now()+15000;
    const worker=async()=>{while(cursor<hosts.length){const host=hosts[cursor++]!;const task=Promise.resolve().then(()=>{if(Date.now()>deadline)throw new WorkspaceError('DNS_BUDGET_EXCEEDED',400);return resolvePublic(host,this.deps.network);});cache.set(host,task);await task.catch(()=>{});}};
    await Promise.all(Array.from({length:Math.min(16,hosts.length)},worker));return cache;
  }
  private async quota(db:PoolClient,additional:number){const count=Number((await db.query('SELECT count(*) FROM app.accounts WHERE deleted_at IS NULL')).rows[0].count);if(count+additional>this.limit)throw new WorkspaceError('ACCOUNT_QUOTA_EXCEEDED');}
  private async snapshot(command:Save<'get'>):Promise<WorkspaceSnapshot>{
    return withTenant(this.deps.pool,this.deps.tenantId,async db=>{
      const groups=(await db.query('SELECT g.*, (SELECT count(*) FROM app.accounts a WHERE a.group_id=g.id AND a.deleted_at IS NULL) AS accounts FROM app.groups g WHERE deleted_at IS NULL ORDER BY name,id')).rows;
      const sites=(await db.query('SELECT * FROM app.site_profiles WHERE deleted_at IS NULL ORDER BY name,id')).rows;
      const proxies=(await db.query('SELECT p.*, (SELECT count(*) FROM app.accounts a WHERE a.proxy_id=p.id AND a.deleted_at IS NULL) AS assigned FROM app.proxies p WHERE p.deleted_at IS NULL ORDER BY p.created_at,p.id')).rows;
      const filter="deleted_at IS NULL AND ($1::uuid IS NULL OR group_id=$1) AND ($2::uuid IS NULL OR site_id=$2) AND ($3='' OR alias ILIKE '%' || $3 || '%')";
      const params=[command.groupId??null,command.siteId??null,command.search];
      const accounts=(await db.query(`SELECT id,alias,group_id,site_id,proxy_id,enabled,account_state,runtime_state,notes,has_login,has_password,version FROM app.accounts WHERE ${filter} ORDER BY created_at,id LIMIT $4 OFFSET $5`,[...params,command.limit,command.offset])).rows;
      const total=Number((await db.query(`SELECT count(*) FROM app.accounts WHERE ${filter}`,params)).rows[0].count);
      const used=Number((await db.query('SELECT count(*) FROM app.accounts WHERE deleted_at IS NULL')).rows[0].count);
      const audit=(await db.query('SELECT id,verb,target_id,created_at FROM app.audit_log ORDER BY created_at DESC,id DESC LIMIT 30')).rows;
      return {groups:groups.map(g=>({id:g.id,name:g.name,enabled:g.enabled,version:g.version,policy:g.policy,accounts:Number(g.accounts)})),sites:sites.map(s=>({id:s.id,name:s.name,url:s.start_url,origins:s.navigation_origins,version:s.version,capability:'generic'})),proxies:proxies.map(p=>({id:p.id,groupId:p.group_id,scheme:p.scheme,host:p.host,port:p.port,maxAccounts:p.max_accounts,assigned:Number(p.assigned),enabled:p.enabled,hasAuth:p.auth_envelope!==null,state:p.state,egressIp:p.observed_egress_ip,latencyMs:p.latency_ms,checkedAt:p.checked_at?.toISOString()??null,errorCode:p.error_code,version:p.version})),accounts:accounts.map(a=>({id:a.id,alias:a.alias,groupId:a.group_id,siteId:a.site_id,proxyId:a.proxy_id,enabled:a.enabled,state:a.account_state,authState:'UNKNOWN',runtimeState:a.runtime_state,notes:a.notes,hasLogin:a.has_login,hasPassword:a.has_password,version:a.version})),total,offset:command.offset,limit:command.limit,quota:{used,max:this.limit},vaultUnlocked:this.deps.vault.unlocked,audit:audit.map(a=>({id:a.id,verb:a.verb,targetId:a.target_id,createdAt:a.created_at.toISOString()}))};
    });
  }
  private async group(db:PoolClient,command:Save<'group.save'>){
    const id=command.id??randomUUID();const old=command.id?await this.row(db,'groups',id,command.version):undefined;
    if(old)await db.query('UPDATE app.groups SET name=$2,enabled=$3,policy=$4,version=version+1,updated_at=now() WHERE id=$1',[id,command.name,command.enabled,command.policy]);
    else {if(Number((await db.query('SELECT count(*) FROM app.groups WHERE deleted_at IS NULL')).rows[0].count)>=100)throw new WorkspaceError('GROUP_LIMIT');await db.query('INSERT INTO app.groups(tenant_id,id,name,enabled,policy) VALUES($1,$2,$3,$4,$5)',[this.deps.tenantId,id,command.name,command.enabled,command.policy]);}
    const version=old?old.version+1:1;
    await db.query('INSERT INTO app.group_policy_versions(tenant_id,group_id,version,policy) VALUES($1,$2,$3,$4)',[this.deps.tenantId,id,version,command.policy]);return {id,version};
  }
  private async site(db:PoolClient,command:Save<'site.save'>){
    const url=await siteUrl(command.url,this.deps.network);const canonicalOrigins:string[]=[];
    for(const raw of command.origins??[url.origin]){const origin=await siteUrl(raw,this.deps.network);if(origin.pathname!=='/'||origin.search||origin.hash)throw new WorkspaceError('INVALID_NAVIGATION_ORIGIN',400);canonicalOrigins.push(origin.origin);}
    const origins=[...new Set(canonicalOrigins)];
    if(!origins.includes(url.origin))throw new WorkspaceError('SITE_ORIGIN_MISSING',400);
    const id=command.id??randomUUID(),old=command.id?await this.row(db,'site_profiles',id,command.version):undefined;
    if(old){
      if((old.start_url!==url.href||JSON.stringify(old.navigation_origins)!==JSON.stringify(origins))&&Number((await db.query('SELECT count(*) FROM app.accounts WHERE site_id=$1 AND deleted_at IS NULL',[id])).rows[0].count))throw new WorkspaceError('SITE_IN_USE');
      await db.query('UPDATE app.site_profiles SET name=$2,start_url=$3,navigation_origins=$4,version=version+1,updated_at=now() WHERE id=$1',[id,command.name,url.href,JSON.stringify(origins)]);
    }else{if(Number((await db.query('SELECT count(*) FROM app.site_profiles WHERE deleted_at IS NULL')).rows[0].count)>=100)throw new WorkspaceError('SITE_LIMIT');await db.query('INSERT INTO app.site_profiles(tenant_id,id,name,start_url,navigation_origins) VALUES($1,$2,$3,$4,$5)',[this.deps.tenantId,id,command.name,url.href,JSON.stringify(origins)]);}
    return {id,version:old?old.version+1:1};
  }
  private async capacity(db:PoolClient,proxyId:string,groupId:string,accountId:string){
    const proxy=await this.row(db,'proxies',proxyId);
    if(proxy.group_id!==groupId)throw new WorkspaceError('PROXY_GROUP_MISMATCH',400);
    if(!proxy.enabled)throw new WorkspaceError('PROXY_DISABLED');
    const assigned=Number((await db.query('SELECT count(*) FROM app.accounts WHERE proxy_id=$1 AND id<>$2 AND deleted_at IS NULL',[proxyId,accountId])).rows[0].count);
    if(assigned>=proxy.max_accounts)throw new WorkspaceError('PROXY_CAPACITY_EXCEEDED');
  }
  private async account(db:PoolClient,command:Save<'account.save'>){
    await this.row(db,'groups',command.groupId);await this.row(db,'site_profiles',command.siteId);
    const id=command.id??randomUUID(),old=command.id?await this.row(db,'accounts',id,command.version):undefined;
    if(old)this.mutable(old);else await this.quota(db,1);
    const moved=old&&(old.group_id!==command.groupId||old.site_id!==command.siteId);
    const siteChanged=old&&old.site_id!==command.siteId;
    if(siteChanged&&old.credential_envelope&&(command.login===undefined||(old.has_password&&command.password===undefined)))throw new WorkspaceError('SITE_CREDENTIAL_REENTRY_REQUIRED');
    if(moved&&old.proxy_id&&command.proxyId===undefined)throw new WorkspaceError('PROXY_REASSIGNMENT_REQUIRED');
    const proxyId=command.proxyId===undefined?old?.proxy_id??null:command.proxyId;
    if(proxyId&&(!old||old.proxy_id!==proxyId||old.group_id!==command.groupId))await this.capacity(db,proxyId,command.groupId,id);
    const replacingCredentials=command.login!==undefined&&command.password!==undefined;
    const credentials:Row=old?.credential_envelope&&!siteChanged&&!replacingCredentials?this.open(old.credential_envelope,old.group_id,id,'credential'):{};
    if(command.login!==undefined)credentials.login=command.login?.normalize('NFKC')??null;
    if(command.password!==undefined)credentials.password=command.password;
    const hasLogin=Boolean(credentials.login),hasPassword=Boolean(credentials.password);
    if(hasPassword&&!hasLogin)throw new WorkspaceError('LOGIN_REQUIRED',400);
    const envelope=hasLogin||hasPassword?this.seal(credentials,command.groupId,id,'credential'):null;
    const lookup=hasLogin?this.deps.vault.lookup(`account:${command.siteId}:${credentials.login}`,this.deps.tenantId):null;
    const values=[id,command.groupId,command.siteId,command.alias,command.enabled,command.state,command.notes,proxyId,envelope,lookup,hasLogin,hasPassword];
    if(old)await db.query('UPDATE app.accounts SET group_id=$2,site_id=$3,alias=$4,enabled=$5,account_state=$6,notes=$7,proxy_id=$8,credential_envelope=$9,login_lookup=$10,has_login=$11,has_password=$12,version=version+1,updated_at=now() WHERE id=$1',values);
    else await db.query('INSERT INTO app.accounts(id,group_id,site_id,alias,enabled,account_state,notes,proxy_id,credential_envelope,login_lookup,has_login,has_password,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[...values,this.deps.tenantId]);
    return {id,version:old?old.version+1:1};
  }
  private async proxy(db:PoolClient,command:Save<'proxy.save'>,hosts?:HostCache){
    await this.row(db,'groups',command.groupId);
    const {host}=await this.resolveHost(command.host,hosts);
    const id=command.id??randomUUID(),old=command.id?await this.row(db,'proxies',id,command.version):undefined;
    if(old){const accounts=(await db.query('SELECT * FROM app.accounts WHERE proxy_id=$1 AND deleted_at IS NULL',[id])).rows;for(const account of accounts)this.mutable(account);if(accounts.length>command.maxAccounts)throw new WorkspaceError('PROXY_CAPACITY_EXCEEDED');if(accounts.length&&old.group_id!==command.groupId)throw new WorkspaceError('PROXY_IN_USE');}
    else if(Number((await db.query('SELECT count(*) FROM app.proxies WHERE deleted_at IS NULL')).rows[0].count)>=500)throw new WorkspaceError('PROXY_LIMIT');
    const endpointChanged=old&&(old.scheme!==command.scheme||old.host!==host||old.port!==command.port);
    if(endpointChanged&&old.auth_envelope&&(command.username===undefined||command.password===undefined))throw new WorkspaceError('PROXY_AUTH_REENTRY_REQUIRED');
    const replacingAuth=command.username!==undefined&&command.password!==undefined;
    const auth:Row=old?.auth_envelope&&!endpointChanged&&!replacingAuth?this.open(old.auth_envelope,old.group_id,id,'proxy'):{};
    if(command.username!==undefined)auth.username=command.username;
    if(command.password!==undefined)auth.password=command.password;
    if(auth.password&&!auth.username)throw new WorkspaceError('PROXY_USERNAME_REQUIRED',400);
    if([auth.username,auth.password].some(value=>value&&Buffer.byteLength(value)>255))throw new WorkspaceError('PROXY_AUTH_TOO_LONG',400);
    const envelope=auth.username?this.seal(auth,command.groupId,id,'proxy'):null;
    this.requireVault();const lookup=this.deps.vault.lookup(`proxy:${auth.username??''}`,this.deps.tenantId);
    const values=[id,command.groupId,command.scheme,host,command.port,envelope,lookup,command.maxAccounts,command.enabled];
    if(old)await db.query("UPDATE app.proxies SET group_id=$2,scheme=$3,host=$4,port=$5,auth_envelope=$6,auth_lookup=$7,max_accounts=$8,enabled=$9,state='UNKNOWN',error_code=NULL,observed_egress_ip=NULL,checked_at=NULL,latency_ms=NULL,version=version+1,updated_at=now() WHERE id=$1",values);
    else await db.query('INSERT INTO app.proxies(id,group_id,scheme,host,port,auth_envelope,auth_lookup,max_accounts,enabled,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[...values,this.deps.tenantId]);
    if(old)await db.query('UPDATE app.accounts SET version=version+1,updated_at=now() WHERE proxy_id=$1 AND deleted_at IS NULL',[id]);
    return {id,version:old?old.version+1:1};
  }
  private async distribute(db:PoolClient,ids:string[],groupId:string,exclude?:string){
    if(new Set(ids).size!==ids.length)throw new WorkspaceError('DUPLICATE_TARGET',400);
    const proxies=(await db.query('SELECT p.*, (SELECT count(*) FROM app.accounts a WHERE a.proxy_id=p.id AND a.deleted_at IS NULL) AS used FROM app.proxies p WHERE p.group_id=$1 AND p.deleted_at IS NULL AND p.enabled AND ($2::uuid IS NULL OR p.id<>$2) ORDER BY p.id',[groupId,exclude??null])).rows.map(p=>({...p,used:Number(p.used)}));
    for(const id of ids){const account=await this.row(db,'accounts',id);this.mutable(account);if(account.group_id!==groupId)throw new WorkspaceError('PROXY_GROUP_MISMATCH',400);if(!exclude&&account.proxy_id)throw new WorkspaceError('PROXY_ALREADY_ASSIGNED');
      const target=proxies.filter(p=>p.used<p.max_accounts).sort((a,b)=>a.used-b.used)[0];if(!target)throw new WorkspaceError('PROXY_CAPACITY_EXCEEDED');target.used++;
      await db.query('UPDATE app.accounts SET proxy_id=$2,version=version+1,updated_at=now() WHERE id=$1',[id,target.id]);
    }return ids.length;
  }
  private previewValue(row:Row):ImportPreview{return {...row.preview,id:row.id,hash:row.hash,state:row.state,expiresAt:row.expires_at.toISOString(),committedIds:row.committed_ids};}
  private async preview(db:PoolClient,command:Save<'import.preview'>){
    this.requireVault();const group=await this.row(db,'groups',command.groupId),site=command.siteId?await this.row(db,'site_profiles',command.siteId):undefined;
    const records=importRecords(command.raw,command.entity),normalized:ParsedWorkspaceCommand[]=[],rows:ImportRow[]=[],seen=new Set<string>();
    const hosts=command.entity==='proxies'?await this.warmHosts(records.map(record=>record.values.host??'')):undefined;
    for(const record of records){
      const source=record.values as Record<string,string>;let value:unknown;
      if(command.entity==='accounts')value={kind:'account.save',groupId:command.groupId,siteId:command.siteId,alias:source.alias?.trim()||`Conta ${record.row}`,login:source.login?.trim()||undefined,password:source.password||undefined,notes:source.notes??'',enabled:!['false','0','nao','não'].includes(source.enabled?.toLowerCase()??'')};
      else value={kind:'proxy.save',groupId:command.groupId,scheme:source.scheme||'http',host:source.host,port:Number(source.port),username:source.username||undefined,password:source.password||undefined,maxAccounts:Number(source.max_accounts||1)};
      const parsed=workspaceCommandSchema.safeParse(value);const errors=record.error?[record.error]:[];let alias=command.entity==='accounts'?(source.alias?.slice(0,120)||`Conta ${record.row}`):`Proxy ${record.row}`;
      if(command.entity==='accounts'&&source.enabled&&!['true','1','sim','false','0','nao','não'].includes(source.enabled.toLowerCase()))errors.push('INVALID_BOOLEAN');
      if(!parsed.success)errors.push('INVALID_ROW');
      else {
        const item=parsed.data;let signature:string|undefined;
        if(item.kind==='account.save'){
          if(item.password&&!item.login)errors.push('LOGIN_REQUIRED');
          if(item.login){signature=this.deps.vault.lookup(`account:${item.siteId}:${item.login.normalize('NFKC')}`,this.deps.tenantId);if((await db.query('SELECT 1 FROM app.accounts WHERE site_id=$1 AND login_lookup=$2 AND deleted_at IS NULL',[item.siteId,signature])).rowCount)errors.push('DUPLICATE_LOGIN');}
        }else if(item.kind==='proxy.save'){
          try{item.host=(await this.resolveHost(item.host,hosts)).host;}catch(error){errors.push(error instanceof WorkspaceError?error.code:'INVALID_PROXY_DESTINATION');}
          if(item.password&&!item.username)errors.push('PROXY_USERNAME_REQUIRED');
          const lookup=this.deps.vault.lookup(`proxy:${item.username??''}`,this.deps.tenantId);signature=`${item.scheme}:${item.host}:${item.port}:${lookup}`;
          if((await db.query('SELECT 1 FROM app.proxies WHERE scheme=$1 AND host=$2 AND port=$3 AND auth_lookup=$4 AND deleted_at IS NULL',[item.scheme,item.host,item.port,lookup])).rowCount)errors.push('DUPLICATE_PROXY');
        }
        if(signature&&!errors.length){if(seen.has(signature))errors.push('DUPLICATE_IN_FILE');else seen.add(signature);}
        if(!errors.length)normalized.push(item);
      }
      rows.push({row:record.row,alias,valid:!errors.length,errors});
    }
    if(!rows.length)throw new WorkspaceError('IMPORT_EMPTY',400);
    const id=randomUUID(),encryptedRows=this.seal(normalized,command.groupId,id,command.entity==='accounts'?'credential':'proxy');
    const hash=createHash('sha256').update(JSON.stringify({id,encryptedRows,rows})).digest('hex'),expiresAt=new Date(Date.now()+30*60000);
    const preview={entity:command.entity,rows,validCount:normalized.length,errorCount:rows.length-normalized.length};
    // Expired staging is removed without retaining credential copies.
    await db.query("DELETE FROM app.workspace_imports WHERE state='PREVIEW' AND expires_at<now()");
    if(Number((await db.query("SELECT count(*) FROM app.workspace_imports WHERE state='PREVIEW'")).rows[0].count)>=20)throw new WorkspaceError('IMPORT_PREVIEW_LIMIT');
    await db.query('INSERT INTO app.workspace_imports(tenant_id,id,group_id,site_id,entity,hash,encrypted_rows,preview,group_version,site_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[this.deps.tenantId,id,command.groupId,command.siteId??null,command.entity,hash,encryptedRows,preview,group.version,site?.version??null,expiresAt]);
    return {id,hash,...preview,expiresAt:expiresAt.toISOString(),state:'PREVIEW' as const,committedIds:[]};
  }
  private async importRow(db:PoolClient,id:string){const row=(await db.query('SELECT * FROM app.workspace_imports WHERE id=$1',[id])).rows[0] as Row|undefined;if(!row)throw new WorkspaceError('NOT_FOUND',404);return row;}
  private async commit(db:PoolClient,command:Save<'import.commit'>){
    const row=await this.importRow(db,command.id);if(row.hash!==command.hash)throw new WorkspaceError('IMPORT_HASH_MISMATCH');if(row.state==='COMMITTED')return this.previewValue(row);
    if(row.expires_at.getTime()<Date.now())throw new WorkspaceError('IMPORT_EXPIRED');
    if(row.preview.errorCount&&!command.acceptPartial)throw new WorkspaceError('IMPORT_HAS_ERRORS');
    await this.row(db,'groups',row.group_id,row.group_version);if(row.site_id)await this.row(db,'site_profiles',row.site_id,row.site_version);
    const data=this.open(row.encrypted_rows,row.group_id,row.id,row.entity==='accounts'?'credential':'proxy') as unknown as ParsedWorkspaceCommand[];
    if(!data.length)throw new WorkspaceError('IMPORT_NO_VALID_ROWS',400);
    if(row.entity==='accounts')await this.quota(db,data.length);
    const hosts=row.entity==='proxies'?await this.warmHosts(data.flatMap(item=>item.kind==='proxy.save'?[item.host]:[])):undefined;
    const ids:string[]=[];
    for(const item of data){const parsed=workspaceCommandSchema.parse(item);if(parsed.kind==='account.save')ids.push((await this.account(db,parsed)).id);else if(parsed.kind==='proxy.save')ids.push((await this.proxy(db,parsed,hosts)).id);else throw new WorkspaceError('IMPORT_INVALID',400);}
    await db.query("UPDATE app.workspace_imports SET state='COMMITTED',encrypted_rows=NULL,committed_ids=$2 WHERE id=$1",[row.id,JSON.stringify(ids)]);
    return this.previewValue({...row,state:'COMMITTED',committed_ids:ids});
  }
  async run(raw:unknown,requestId:string):Promise<WorkspaceResult>{
    const command=workspaceCommandSchema.parse(raw);
    if(command.kind==='get')return {snapshot:await this.snapshot(command)};
    if(command.kind==='proxy.test'){
      const before:Row=await this.tx(async db=>{const proxy=await this.row(db,'proxies',command.id,command.version);return {...proxy,auth:proxy.auth_envelope?this.open(proxy.auth_envelope,proxy.group_id,proxy.id,'proxy'):undefined};});
      if(!before.enabled)throw new WorkspaceError('PROXY_DISABLED');
      const endpoint:ProxyEndpoint={scheme:before.scheme,host:before.host,port:before.port,...before.auth};
      const check=await checkProxy(endpoint,this.deps.probeUrl??'https://api64.ipify.org?format=json',this.deps.network);
      await this.tx(async db=>{await this.row(db,'proxies',command.id,command.version);await db.query('UPDATE app.proxies SET state=$2,observed_egress_ip=$3,latency_ms=$4,error_code=$5,checked_at=now() WHERE id=$1',[command.id,check.state,check.egressIp,check.latencyMs,check.errorCode]);await this.audit(db,'proxy.tested',command.id,requestId);});return {check};
    }
    return this.tx(async db=>{
      let result:WorkspaceResult={},targetId='id'in command?command.id??this.deps.tenantId:this.deps.tenantId;
      switch(command.kind){
        case 'group.save':result.entity=await this.group(db,command);break;
        case 'site.save':result.entity=await this.site(db,command);break;
        case 'account.save':result.entity=await this.account(db,command);break;
        case 'account.enabled':{const account=await this.row(db,'accounts',command.id,command.version);if(command.enabled)this.mutable(account);await db.query('UPDATE app.accounts SET enabled=$2,version=version+1,updated_at=now() WHERE id=$1',[command.id,command.enabled]);result.entity={id:command.id,version:account.version+1};break;}
        case 'proxy.save':result.entity=await this.proxy(db,command);break;
        case 'group.delete':{await this.row(db,'groups',command.id,command.version);const used=await db.query('SELECT 1 FROM app.accounts WHERE group_id=$1 AND deleted_at IS NULL UNION ALL SELECT 1 FROM app.proxies WHERE group_id=$1 AND deleted_at IS NULL LIMIT 1',[command.id]);if(used.rowCount)throw new WorkspaceError('GROUP_IN_USE');await db.query('UPDATE app.groups SET deleted_at=now(),enabled=false,version=version+1 WHERE id=$1',[command.id]);break;}
        case 'site.delete':{await this.row(db,'site_profiles',command.id,command.version);if((await db.query('SELECT 1 FROM app.accounts WHERE site_id=$1 AND deleted_at IS NULL LIMIT 1',[command.id])).rowCount)throw new WorkspaceError('SITE_IN_USE');await db.query('UPDATE app.site_profiles SET deleted_at=now(),version=version+1 WHERE id=$1',[command.id]);break;}
        case 'account.delete':{const account=await this.row(db,'accounts',command.id,command.version);this.mutable(account);await db.query('UPDATE app.accounts SET deleted_at=now(),enabled=false,proxy_id=NULL,credential_envelope=NULL,login_lookup=NULL,has_login=false,has_password=false,version=version+1 WHERE id=$1',[command.id]);break;}
        case 'proxy.delete':{await this.row(db,'proxies',command.id,command.version);if((await db.query('SELECT 1 FROM app.accounts WHERE proxy_id=$1 AND deleted_at IS NULL LIMIT 1',[command.id])).rowCount)throw new WorkspaceError('PROXY_IN_USE');await db.query('UPDATE app.proxies SET deleted_at=now(),enabled=false,auth_envelope=NULL,version=version+1 WHERE id=$1',[command.id]);break;}
        case 'proxy.distribute':result.assigned=await this.distribute(db,command.accountIds,command.groupId);break;
        case 'proxy.rotate':{const proxy=await this.row(db,'proxies',command.id,command.version);const accounts=(await db.query('SELECT id FROM app.accounts WHERE proxy_id=$1 AND deleted_at IS NULL ORDER BY id',[command.id])).rows;result.assigned=await this.distribute(db,accounts.map(a=>a.id),proxy.group_id,proxy.id);break;}
        case 'import.preview':result.preview=await this.preview(db,command);break;
        case 'import.get':return {preview:this.previewValue(await this.importRow(db,command.id))};
        case 'import.commit':result.preview=await this.commit(db,command);break;
      }
      targetId=result.entity?.id??result.preview?.id??targetId;await this.audit(db,command.kind,targetId,requestId);return result;
    });
  }
}
