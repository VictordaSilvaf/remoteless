import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {withTenant,type Pool,type PoolClient} from '@msm/database';
import {engineCommandSchema,type ParsedEngineCommand,type EngineResult,type EngineSnapshot,type RecipeRecord,type ExecutionPlan,type ActionState} from '@msm/contracts';
import {WorkspaceError} from '../workspace/errors.js';
import {canonical,digest,schedule,type PlanSnapshot,type TargetSnapshot} from './planner.js';
import {describe,type AdapterRegistry,type ActionContext,type ExecutionOutcome} from './adapters.js';

type Row=Record<string,any>;
type Command<K extends ParsedEngineCommand['kind']>=Extract<ParsedEngineCommand,{kind:K}>;
const pending=['WAITING_PREDECESSOR','SCHEDULED','READY','RETRY_WAIT'];
const inFlight=['LEASED','RUNNING','VERIFYING'];
const unsafe=['RECONCILING','UNKNOWN'];
const terminal=['SUCCEEDED','FAILED','CANCELLED','EXPIRED','ABANDONED'];
export interface Lease {actionId:string;accountId:string;groupId:string;proxyId:string|null;attempt:number;leaseEpoch:number;token:string;owner:string;kind:'account.inspect'|'proxy.probe';}
interface Dependencies {pool:InstanceType<typeof Pool>;tenantId:string;actorId:string;adapters:AdapterRegistry;concurrency?:number;leaseSeconds?:number;now?:()=>number;}
export class EngineService {
  readonly concurrency:number;
  readonly leaseSeconds:number;
  readonly now:()=>number;
  private databaseTime=Date.now();
  private clockSample=performance.now();
  runtime={available:false,lastTickAt:null as string|null,queue:'unavailable' as 'healthy'|'unavailable',lastError:null as string|null};
  constructor(readonly deps:Dependencies){
    this.concurrency=deps.concurrency??4;this.leaseSeconds=deps.leaseSeconds??30;this.now=deps.now??(()=>this.databaseTime+performance.now()-this.clockSample);
    if(!Number.isInteger(this.concurrency)||this.concurrency<1||this.concurrency>6||this.leaseSeconds<3||this.leaseSeconds>120)throw Error('INVALID_ENGINE_LIMIT');
  }
  private date(offset=0){return new Date(this.now()+offset*1000);}
  private tx<T>(work:(db:PoolClient)=>Promise<T>){return withTenant(this.deps.pool,this.deps.tenantId,async db=>{
    // Same lock as registry mutations: confirmation/admission cannot race a route or policy edit.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`workspace:${this.deps.tenantId}`]);
    if(!this.deps.now){const row=(await db.query('SELECT clock_timestamp() AS time')).rows[0];this.databaseTime=row.time.getTime();this.clockSample=performance.now();}
    return work(db);
  });}
  private async audit(db:PoolClient,verb:string,id:string,requestId:string){await db.query('INSERT INTO app.audit_log(tenant_id,id,actor_id,verb,target_id,request_id) VALUES($1,$2,$3,$4,$5,$6)',[this.deps.tenantId,randomUUID(),this.deps.actorId,verb,id,requestId]);}
  private async action(db:PoolClient,id:string,version?:number):Promise<Row>{const row=(await db.query('SELECT * FROM app.action_intents WHERE id=$1',[id])).rows[0];if(!row)throw new WorkspaceError('NOT_FOUND',404);if(version!==undefined&&row.version!==version)throw new WorkspaceError('VERSION_CONFLICT');return row;}
  private async transition(db:PoolClient,row:Row,state:ActionState,reason:string){
    const from=row.state as string|null,version=from?row.version+1:1;
    if(from){const updated=await db.query('UPDATE app.action_intents SET state=$2,version=$3,reason=$4,updated_at=$5 WHERE id=$1 AND version=$6',[row.id,state,version,reason,this.date(),row.version]);if(!updated.rowCount)throw new WorkspaceError('VERSION_CONFLICT');}
    await db.query('INSERT INTO app.action_transitions(tenant_id,id,action_id,from_state,to_state,action_version,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[this.deps.tenantId,randomUUID(),row.id,from,state,version,reason,this.date()]);
    row.state=state;row.version=version;row.reason=reason;
    if(state==='READY')await db.query('INSERT INTO app.outbox_events(tenant_id,id,topic,entity_id,payload) VALUES($1,$2,$3,$4,$5)',[this.deps.tenantId,randomUUID(),'engine.action',row.id,{version:1,actionId:row.id,actionVersion:version}]);
  }
  private async recipe(db:PoolClient,id:string,version?:number):Promise<RecipeRecord&{adapters:Row[]}>{
    const row=(await db.query('SELECT r.id,r.name,r.version,v.steps,v.adapters FROM app.recipes r JOIN app.recipe_versions v ON v.tenant_id=r.tenant_id AND v.recipe_id=r.id AND v.version=r.version WHERE r.id=$1',[id])).rows[0];
    if(!row)throw new WorkspaceError('NOT_FOUND',404);if(version!==undefined&&row.version!==version)throw new WorkspaceError('VERSION_CONFLICT');return row;
  }
  private async targets(db:PoolClient,ids:string[],needsProxy:boolean):Promise<TargetSnapshot[]>{
    const rows=(await db.query(`SELECT a.id,a.alias,a.version,a.group_id,a.site_id,a.proxy_id,a.enabled,a.account_state,a.runtime_state,a.deleted_at,
      g.version AS group_version,g.enabled AS group_enabled,g.deleted_at AS group_deleted,g.policy,s.version AS site_version,s.deleted_at AS site_deleted,
      p.version AS proxy_version,p.enabled AS proxy_enabled,p.state AS proxy_state,p.deleted_at AS proxy_deleted,
      h.epoch,h.blocked_reason FROM app.accounts a JOIN app.groups g ON g.tenant_id=a.tenant_id AND g.id=a.group_id
      JOIN app.site_profiles s ON s.tenant_id=a.tenant_id AND s.id=a.site_id LEFT JOIN app.proxies p ON p.tenant_id=a.tenant_id AND p.id=a.proxy_id
      LEFT JOIN app.execution_heads h ON h.tenant_id=a.tenant_id AND h.account_id=a.id WHERE a.id=ANY($1::uuid[])`,[ids])).rows;
    return ids.map(id=>{
      const a=rows.find(row=>row.id===id);if(!a)throw new WorkspaceError('NOT_FOUND',404);
      const reason=a.deleted_at?'ACCOUNT_REMOVED':!a.enabled?'ACCOUNT_DISABLED':a.group_deleted||!a.group_enabled?'GROUP_DISABLED':a.site_deleted?'SITE_REMOVED':a.blocked_reason?'CHAIN_BLOCKED':a.runtime_state!=='DORMANT'?'ACCOUNT_BUSY':['BANNED','BLOCKED','LOGIN_ERROR','MAINTENANCE'].includes(a.account_state)?'ACCOUNT_RESTRICTED':needsProxy&&!a.proxy_id?'PROXY_REQUIRED':a.proxy_id&&(a.proxy_deleted||!a.proxy_enabled||a.proxy_state==='UNAVAILABLE')?'PROXY_UNAVAILABLE':null;
      return {accountId:a.id,alias:a.alias,groupId:a.group_id,accountVersion:a.version,groupVersion:a.group_version,siteVersion:a.site_version,proxyId:a.proxy_id,proxyVersion:a.proxy_version??null,epoch:a.epoch??1,policy:a.policy,eligible:reason===null,reason,offsets:[]};
    });
  }
  private adapterSnapshot(steps:RecipeRecord['steps']){return steps.map(step=>{const adapter=this.deps.adapters.get(step.kind);if(!adapter)throw new WorkspaceError('ADAPTER_UNAVAILABLE');return describe(adapter);});}
  private publicPlan(row:Row,snapshot:PlanSnapshot,token:string):ExecutionPlan{
    const eligible=snapshot.targets.filter(t=>t.eligible).length;
    return {id:row.id,hash:row.canonical_hash,token,expiresAt:row.expires_at.toISOString(),recipeName:snapshot.recipeName,mode:snapshot.mode,windowSeconds:snapshot.windowSeconds,targets:snapshot.targets.map(t=>({accountId:t.accountId,alias:t.alias,groupId:t.groupId,eligible:t.eligible,reason:t.reason,offsets:t.offsets})),eligible,excluded:snapshot.targets.length-eligible,actions:eligible*snapshot.steps.length,estimatedSeconds:snapshot.estimatedSeconds,warnings:['Horários relativos à confirmação; concorrência e quotas continuam valendo.','Diagnósticos não comprovam login, banimento ou disponibilidade de uma sessão.']};
  }
  private async preview(db:PoolClient,command:Command<'plan.preview'>){
    if(new Set(command.accountIds).size!==command.accountIds.length)throw new WorkspaceError('DUPLICATE_TARGET',400);
    if(command.mode==='immediate'&&!command.acknowledgeImmediate)throw new WorkspaceError('IMMEDIATE_CONFIRMATION_REQUIRED',400);
    const recipe=await this.recipe(db,command.recipeId,command.recipeVersion),adapters=this.adapterSnapshot(recipe.steps);
    if(canonical(adapters)!==canonical(recipe.adapters))throw new WorkspaceError('ADAPTER_VERSION_CHANGED');
    if(Number((await db.query('SELECT count(*) FROM app.execution_plans WHERE consumed_at IS NULL AND expires_at>$1',[this.date()])).rows[0].count)>=20)throw new WorkspaceError('PLAN_LIMIT');
    const targets=await this.targets(db,command.accountIds,recipe.steps.some(s=>s.kind==='proxy.probe'));
    const reservations=(await db.query('SELECT scope_kind AS kind,scope_id AS id,EXTRACT(EPOCH FROM reserved_at-$1::timestamptz)::float AS offset FROM app.quota_reservations WHERE reserved_at>$2',[this.date(),this.date(-3600)])).rows;
    const snapshot=schedule({recipeId:recipe.id,recipeVersion:recipe.version,recipeName:recipe.name,steps:recipe.steps,adapters,seed:randomBytes(32).toString('hex'),mode:command.mode,windowSeconds:command.windowSeconds,targets,estimatedSeconds:0,concurrency:this.concurrency},reservations);
    const id=randomUUID(),token=randomBytes(32).toString('base64url'),hash=digest(canonical(snapshot)),expires=this.date(300);
    await db.query('INSERT INTO app.execution_plans(tenant_id,id,actor_id,recipe_id,recipe_version,snapshot,canonical_hash,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[this.deps.tenantId,id,this.deps.actorId,recipe.id,recipe.version,snapshot,hash,digest(token),expires]);
    return this.publicPlan({id,canonical_hash:hash,expires_at:expires},snapshot,token);
  }
  private async confirm(db:PoolClient,command:Command<'plan.confirm'>){
    const row=(await db.query('SELECT * FROM app.execution_plans WHERE id=$1 AND actor_id=$2',[command.id,this.deps.actorId])).rows[0];
    if(!row)throw new WorkspaceError('NOT_FOUND',404);
    const supplied=Buffer.from(digest(command.token),'hex'),expected=Buffer.from(row.token_hash,'hex');
    if(row.canonical_hash!==command.hash||!timingSafeEqual(supplied,expected))throw new WorkspaceError('PLAN_CONFIRMATION_REJECTED',403);
    if(row.consumed_at){if(row.idempotency_key!==command.idempotencyKey)throw new WorkspaceError('PLAN_ALREADY_CONSUMED');return row.campaign_id as string;}
    if(row.expires_at<=this.date())throw new WorkspaceError('PLAN_EXPIRED');
    if((await db.query('SELECT 1 FROM app.execution_plans WHERE actor_id=$1 AND idempotency_key=$2',[this.deps.actorId,command.idempotencyKey])).rowCount)throw new WorkspaceError('IDEMPOTENCY_CONFLICT');
    const plan=row.snapshot as PlanSnapshot;
    await this.recipe(db,plan.recipeId,plan.recipeVersion);
    if(canonical(this.adapterSnapshot(plan.steps))!==canonical(plan.adapters))throw new WorkspaceError('ADAPTER_VERSION_CHANGED');
    const current=await this.targets(db,plan.targets.map(t=>t.accountId),plan.steps.some(s=>s.kind==='proxy.probe'));
    if(canonical(current)!==canonical(plan.targets.map(t=>({...t,offsets:[]}))))throw new WorkspaceError('PLAN_STALE');
    const targets=plan.targets.filter(t=>t.eligible);if(!targets.length)throw new WorkspaceError('NO_ELIGIBLE_ACCOUNTS');
    const active=Number((await db.query('SELECT count(*) FROM app.action_intents WHERE NOT(state=ANY($1::text[]))',[terminal])).rows[0].count);
    if(active+targets.length*plan.steps.length>20000)throw new WorkspaceError('ENGINE_BACKLOG_LIMIT');
    // Re-simulate with current rolling quota use. The frozen schedule must still fit.
    const reservations=(await db.query('SELECT scope_kind AS kind,scope_id AS id,EXTRACT(EPOCH FROM reserved_at-$1::timestamptz)::float AS offset FROM app.quota_reservations WHERE reserved_at>$2',[this.date(),this.date(-3600)])).rows;
    const simulated=schedule(structuredClone({...plan,targets:plan.targets.map(t=>({...t,offsets:[]}))}),reservations);
    if(canonical(simulated.targets)!==canonical(plan.targets))throw new WorkspaceError('PLAN_CAPACITY_CHANGED');
    const campaignId=randomUUID(),starts=this.date(2),deadline=new Date(starts.getTime()+plan.windowSeconds*1000);
    await db.query('INSERT INTO app.campaigns(tenant_id,id,plan_id,name,mode,starts_at,deadline) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.deps.tenantId,campaignId,row.id,plan.recipeName,plan.mode,starts,deadline]);
    for(const target of targets){
      await db.query('INSERT INTO app.execution_heads(tenant_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[this.deps.tenantId,target.accountId]);
      let previous:string|null=null;
      for(let step=0;step<plan.steps.length;step++){
        const id=randomUUID(),state=step===0?'SCHEDULED':'WAITING_PREDECESSOR',adapter=plan.adapters[step]!;
        const earliest=new Date(starts.getTime()+target.offsets[step]!*1000);
        const remaining=plan.adapters.slice(step).reduce((sum,a)=>sum+Math.ceil(a.estimatedSeconds/0.7),0);
        await db.query(`INSERT INTO app.action_intents(tenant_id,id,campaign_id,account_id,group_id,proxy_id,step_no,depends_on_id,spec,adapter_version,replay_safe,snapshot,state,earliest_start,latest_start,deadline)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[this.deps.tenantId,id,campaignId,target.accountId,target.groupId,target.proxyId,step,previous,plan.steps[step],adapter.version,adapter.replaySafe,target,state,earliest,new Date(deadline.getTime()-remaining*1000),deadline]);
        await this.transition(db,{id,state:null,version:0},state,'CAMPAIGN_CONFIRMED');previous=id;
      }
    }
    await db.query('UPDATE app.execution_plans SET consumed_at=$2,campaign_id=$3,idempotency_key=$4 WHERE id=$1',[row.id,this.date(),campaignId,command.idempotencyKey]);
    return campaignId;
  }
  private async release(db:PoolClient,row:Row,block:string|null){
    await db.query('UPDATE app.execution_heads SET current_action_id=NULL,blocked_reason=$3 WHERE account_id=$1 AND last_action_id=$2 AND (current_action_id=$2 OR current_action_id IS NULL)',[row.account_id,row.id,block]);
    await db.query('UPDATE app.accounts SET runtime_state=$2 WHERE id=$1',[row.account_id,block?'ERROR':'DORMANT']);
    await db.query('UPDATE app.action_intents SET lease_expires_at=NULL,lease_token_hash=NULL WHERE id=$1',[row.id]);
  }
  private async cancelAction(db:PoolClient,row:Row){
    if(terminal.includes(row.state))return;
    if(!row.cancel_requested_at){await db.query('UPDATE app.action_intents SET cancel_requested_at=$2 WHERE id=$1',[row.id,this.date()]);row.cancel_requested_at=this.date();await this.transition(db,row,row.state,'CANCELLATION_REQUESTED');}
    if(pending.includes(row.state)){
      await this.transition(db,row,'CANCELLED','CANCELLED_BEFORE_EXECUTION');
      // An admitted chain cannot silently let an independent campaign skip its failed predecessor.
      if(row.dispatch_seq!==null)await this.release(db,row,'CANCELLED');
    }
  }
  async run(input:unknown,requestId:string):Promise<EngineResult>{
    const command=engineCommandSchema.parse(input);
    if(command.kind==='get')return {snapshot:await this.snapshot(command)};
    if(command.kind==='action.reconcile'){await this.reconcile(command.id,command.version);return {};}
    if(command.kind==='chain.reset'){await this.reset(command.accountId,command.epoch,command.reason,requestId);return {};}
    return this.tx(async db=>{
      let result:EngineResult={},target:string;
      switch(command.kind){
        case 'recipe.save':{
          const adapters=this.adapterSnapshot(command.steps),id=command.id??randomUUID();
          if(command.id){if(command.version===undefined)throw new WorkspaceError('VERSION_REQUIRED',400);await this.recipe(db,id,command.version);await db.query('UPDATE app.recipes SET name=$2,version=version+1 WHERE id=$1',[id,command.name]);}
          else {if(Number((await db.query('SELECT count(*) FROM app.recipes')).rows[0].count)>=100)throw new WorkspaceError('RECIPE_LIMIT');await db.query('INSERT INTO app.recipes(tenant_id,id,name,version) VALUES($1,$2,$3,1)',[this.deps.tenantId,id,command.name]);}
          const version=command.id?command.version!+1:1;
          await db.query('INSERT INTO app.recipe_versions(tenant_id,recipe_id,version,steps,adapters) VALUES($1,$2,$3,$4,$5)',[this.deps.tenantId,id,version,JSON.stringify(command.steps),JSON.stringify(adapters)]);
          result={recipe:{id,name:command.name,version,steps:command.steps}};target=id;break;
        }
        case 'plan.preview':result={plan:await this.preview(db,command)};target=result.plan!.id;break;
        case 'plan.confirm':result={campaignId:await this.confirm(db,command)};target=result.campaignId!;break;
        case 'campaign.cancel':{
          const campaign=(await db.query('SELECT * FROM app.campaigns WHERE id=$1',[command.id])).rows[0];
          if(!campaign)throw new WorkspaceError('NOT_FOUND',404);if(campaign.version!==command.version)throw new WorkspaceError('VERSION_CONFLICT');
          await db.query('UPDATE app.campaigns SET cancel_requested_at=COALESCE(cancel_requested_at,$2),version=version+1 WHERE id=$1',[command.id,this.date()]);
          for(const row of (await db.query('SELECT * FROM app.action_intents WHERE campaign_id=$1 ORDER BY account_id,step_no',[command.id])).rows)await this.cancelAction(db,row);
          await this.refreshCampaigns(db);target=command.id;break;
        }
        case 'action.cancel':await this.cancelAction(db,await this.action(db,command.id,command.version));await this.refreshCampaigns(db);target=command.id;break;
      }
      await this.audit(db,`engine.${command.kind}`,target,requestId);return result;
    });
  }
  private async snapshot(command:Command<'get'>):Promise<EngineSnapshot>{return withTenant(this.deps.pool,this.deps.tenantId,async db=>{
    const recipes=(await db.query('SELECT r.id,r.name,r.version,v.steps FROM app.recipes r JOIN app.recipe_versions v ON v.tenant_id=r.tenant_id AND v.recipe_id=r.id AND v.version=r.version ORDER BY r.created_at,r.id')).rows as RecipeRecord[];
    const campaigns=(await db.query(`SELECT c.*,COALESCE((SELECT jsonb_object_agg(x.state,x.count) FROM (SELECT state,count(*)::int AS count FROM app.action_intents a WHERE a.campaign_id=c.id GROUP BY state)x),'{}') AS counts FROM app.campaigns c ORDER BY created_at DESC,id DESC LIMIT 50`)).rows;
    const filter='($1::uuid IS NULL OR a.campaign_id=$1)',args=[command.campaignId??null];
    const actions=(await db.query(`SELECT a.*,ac.alias,h.epoch FROM app.action_intents a JOIN app.accounts ac ON ac.tenant_id=a.tenant_id AND ac.id=a.account_id JOIN app.execution_heads h ON h.tenant_id=a.tenant_id AND h.account_id=a.account_id WHERE ${filter} ORDER BY a.created_at DESC,a.campaign_id,a.account_id,a.step_no LIMIT $2 OFFSET $3`,[...args,command.limit,command.offset])).rows;
    const total=Number((await db.query(`SELECT count(*) FROM app.action_intents a WHERE ${filter}`,args)).rows[0].count);
    const transitions=(await db.query(`SELECT t.* FROM app.action_transitions t JOIN app.action_intents a ON a.tenant_id=t.tenant_id AND a.id=t.action_id WHERE ${filter} ORDER BY t.created_at DESC,t.id DESC LIMIT 100`,args)).rows;
    const metrics=(await db.query('SELECT count(*) FILTER(WHERE state=ANY($1::text[]))::int AS pending,count(*) FILTER(WHERE state=ANY($2::text[]))::int AS inflight,count(*) FILTER(WHERE state=ANY($3::text[]))::int AS uncertain FROM app.action_intents',[pending,inFlight,unsafe])).rows[0];
    const outboxPending=Number((await db.query("SELECT count(*) FROM app.outbox_events o JOIN app.action_intents a ON a.tenant_id=o.tenant_id AND a.id=o.entity_id WHERE o.topic='engine.action' AND o.published_at IS NULL AND a.state='READY'")).rows[0].count);
    return {recipes,campaigns:campaigns.map(c=>({id:c.id,name:c.name,state:c.state,mode:c.mode,version:c.version,createdAt:c.created_at.toISOString(),deadline:c.deadline.toISOString(),cancelRequested:c.cancel_requested_at!==null,counts:c.counts})),actions:actions.map(a=>({id:a.id,accountId:a.account_id,alias:a.alias,campaignId:a.campaign_id,step:a.step_no,kind:a.spec.kind,state:a.state,version:a.version,attempts:a.attempt_count,earliestStart:a.earliest_start.toISOString(),deadline:a.deadline.toISOString(),cancelRequested:a.cancel_requested_at!==null,reason:a.reason,epoch:a.epoch})),transitions:transitions.map(t=>({id:t.id,actionId:t.action_id,from:t.from_state,to:t.to_state,version:t.action_version,reason:t.reason,createdAt:t.created_at.toISOString()})),total,offset:command.offset,limit:command.limit,metrics:{pending:metrics.pending,inFlight:metrics.inflight,uncertain:metrics.uncertain,outboxPending},engine:{...this.runtime,concurrency:this.concurrency}};
  });}
  private async refreshCampaigns(db:PoolClient){
    await db.query(`WITH summary AS (SELECT campaign_id,count(*) AS total,count(*) FILTER(WHERE state='SUCCEEDED') AS success,count(*) FILTER(WHERE state='CANCELLED') AS cancelled,
      count(*) FILTER(WHERE state=ANY($1::text[])) AS active,count(*) FILTER(WHERE state=ANY($2::text[])) AS uncertain FROM app.action_intents GROUP BY campaign_id),
      desired AS (SELECT c.id,CASE WHEN s.uncertain>0 OR s.active>0 AND EXISTS(SELECT 1 FROM app.action_intents a JOIN app.execution_heads h ON h.tenant_id=a.tenant_id AND h.account_id=a.account_id WHERE a.campaign_id=c.id AND a.state=ANY($1::text[]) AND h.blocked_reason IS NOT NULL) THEN 'BLOCKED' WHEN s.active>0 THEN CASE WHEN c.state='QUEUED' AND NOT EXISTS(SELECT 1 FROM app.action_intents a WHERE a.campaign_id=c.id AND a.attempt_count>0) THEN 'QUEUED' ELSE 'RUNNING' END
      WHEN s.success=s.total THEN 'SUCCEEDED' WHEN s.cancelled=s.total THEN 'CANCELLED' ELSE 'PARTIAL' END AS state FROM app.campaigns c JOIN summary s ON s.campaign_id=c.id)
      UPDATE app.campaigns c SET state=d.state,version=c.version+1 FROM desired d WHERE c.id=d.id AND c.state<>d.state`,[[...pending,...inFlight],unsafe]);
  }
  /** Periodic recovery is driven by PostgreSQL, including after complete Redis loss. */
  async tick(){return this.tx(async db=>{
    const expired=(await db.query('SELECT * FROM app.action_intents WHERE state=ANY($1::text[]) AND lease_expires_at<=$2 ORDER BY account_id',[inFlight,this.date()])).rows;
    for(const row of expired){
      if(row.state==='VERIFYING'){
        await this.transition(db,row,'RECONCILING','LEASE_EXPIRED_AFTER_EFFECT_INTENT');await this.release(db,row,'RECONCILING');
      }else await this.safeRetry(db,row,'LEASE_EXPIRED_BEFORE_EFFECT');
      await db.query('UPDATE app.action_attempts SET finished_at=$3,outcome=$4 WHERE action_id=$1 AND attempt_no=$2 AND finished_at IS NULL',[row.id,row.attempt_count,this.date(),row.state==='RECONCILING'?'UNCERTAIN':'LEASE_EXPIRED']);
    }
    const rows=(await db.query('SELECT a.*,c.cancel_requested_at AS campaign_cancelled FROM app.action_intents a JOIN app.campaigns c ON c.tenant_id=a.tenant_id AND c.id=a.campaign_id WHERE a.state=ANY($1::text[]) ORDER BY row_number() OVER(PARTITION BY a.group_id ORDER BY a.created_at,a.campaign_id,a.account_id,a.step_no),a.created_at,a.account_id,a.step_no',[pending])).rows;
    let readyBudget=Math.max(0,this.concurrency*2-Number((await db.query('SELECT count(*) FROM app.action_intents WHERE state=ANY($1::text[])',[['READY',...inFlight]])).rows[0].count));
    for(const row of rows){
      if(row.cancel_requested_at||row.campaign_cancelled){await this.cancelAction(db,row);continue;}
      if(row.latest_start<this.date()){
        await this.transition(db,row,'EXPIRED','DEADLINE_ELAPSED');if(row.dispatch_seq!==null)await this.release(db,row,'EXPIRED');continue;
      }
      if(row.depends_on_id){const predecessor=await this.action(db,row.depends_on_id);if(predecessor.state!=='SUCCEEDED'){
        if(terminal.includes(predecessor.state)&&predecessor.state!=='SUCCEEDED')await this.transition(db,row,'CANCELLED','PREDECESSOR_NOT_SUCCEEDED');continue;
      }}
      if(row.state==='READY')continue;
      if(row.earliest_start>this.date())continue;
      // Avoid generating a fresh outbox event on every tick for an occupied account.
      const head=(await db.query('SELECT current_action_id,last_action_id,blocked_reason FROM app.execution_heads WHERE account_id=$1',[row.account_id])).rows[0];
      if(head.blocked_reason){if(head.last_action_id&&terminal.includes((await this.action(db,head.last_action_id)).state))await this.transition(db,row,'CANCELLED','GLOBAL_PREDECESSOR_NOT_SUCCEEDED');continue;}
      if(readyBudget<=0||head.current_action_id&&head.current_action_id!==row.id)continue;
      const earlier=(await db.query('SELECT 1 FROM app.action_intents WHERE account_id=$1 AND id<>$2 AND state=ANY($3::text[]) AND (created_at,campaign_id,step_no)<($4,$5,$6) LIMIT 1',[row.account_id,row.id,[...pending,...inFlight,...unsafe],row.created_at,row.campaign_id,row.step_no])).rowCount;
      if(earlier)continue;
      await this.transition(db,row,'READY','SCHEDULE_ELIGIBLE');
      readyBudget--;
    }
    await this.refreshCampaigns(db);this.runtime.lastTickAt=this.date().toISOString();
    return (await db.query("SELECT id FROM app.action_intents WHERE state='RECONCILING' ORDER BY updated_at LIMIT 20")).rows.map(r=>r.id as string);
  });}
  async tickets(){return withTenant(this.deps.pool,this.deps.tenantId,async db=>(await db.query(`SELECT o.id,o.entity_id FROM app.outbox_events o JOIN app.action_intents a ON a.tenant_id=o.tenant_id AND a.id=o.entity_id WHERE o.topic='engine.action' AND a.state='READY' AND o.payload->>'actionVersion'=a.version::text AND (o.last_published_at IS NULL OR o.last_published_at<$1) ORDER BY row_number() OVER(PARTITION BY a.group_id ORDER BY o.created_at,o.id),o.created_at,o.id LIMIT 100`,[this.date(-10)])).rows as {id:string;entity_id:string}[]);}
  async published(id:string){await withTenant(this.deps.pool,this.deps.tenantId,db=>db.query("UPDATE app.outbox_events SET published_at=COALESCE(published_at,$2),last_published_at=$2,publish_attempts=publish_attempts+1 WHERE id=$1 AND topic='engine.action'",[id,this.date()]));}
  async deliveryFailed(eventId:string,actionId:string){await this.tx(async db=>{
    const event=(await db.query("SELECT payload FROM app.outbox_events WHERE id=$1 AND entity_id=$2 AND topic='engine.action'",[eventId,actionId])).rows[0];
    if(!event)return;const row=await this.action(db,actionId);
    if(row.state==='READY'&&row.version===event.payload.actionVersion)await this.defer(db,row,5,'TRANSPORT_DELIVERY_FAILED');
  });}
  private async defer(db:PoolClient,row:Row,seconds:number,reason:string){await db.query('UPDATE app.action_intents SET earliest_start=$2 WHERE id=$1',[row.id,this.date(seconds)]);await this.transition(db,row,'SCHEDULED',reason);}
  async claim(eventId:string,actionId:string,owner:string):Promise<Lease|null>{return this.tx(async db=>{
    const event=(await db.query("SELECT payload FROM app.outbox_events WHERE id=$1 AND entity_id=$2 AND topic='engine.action'",[eventId,actionId])).rows[0];if(!event)return null;
    const row=await this.action(db,actionId);if(row.state!=='READY'||event.payload.actionVersion!==row.version)return null;
    const campaign=(await db.query('SELECT * FROM app.campaigns WHERE id=$1',[row.campaign_id])).rows[0];
    if(row.cancel_requested_at||campaign.cancel_requested_at){await this.cancelAction(db,row);return null;}
    if(row.latest_start<this.date()){await this.transition(db,row,'EXPIRED','DEADLINE_ELAPSED');if(row.dispatch_seq!==null)await this.release(db,row,'EXPIRED');return null;}
    if(row.depends_on_id&&(await this.action(db,row.depends_on_id)).state!=='SUCCEEDED')return null;
    const target=(await this.targets(db,[row.account_id],row.spec.kind==='proxy.probe'))[0]!;
    const head=(await db.query('SELECT * FROM app.execution_heads WHERE account_id=$1',[row.account_id])).rows[0];
    if(head.current_action_id&&head.current_action_id!==row.id){await this.defer(db,row,1,'ACCOUNT_OWNED');return null;}
    if(head.blocked_reason){await this.transition(db,row,'CANCELLED','CHAIN_BLOCKED');return null;}
    // During a safe retry this action owns its execution head; registry runtime is dormant.
    if(!target.eligible||target.accountVersion!==row.snapshot.accountVersion||target.groupVersion!==row.snapshot.groupVersion||target.siteVersion!==row.snapshot.siteVersion||target.proxyVersion!==row.snapshot.proxyVersion||target.proxyId!==row.proxy_id||target.groupId!==row.group_id||head.epoch!==row.snapshot.epoch){
      await this.transition(db,row,'FAILED',target.reason??'CONFIGURATION_CHANGED');
      if(!head.current_action_id||head.current_action_id===row.id){await db.query('UPDATE app.execution_heads SET last_action_id=$2,current_action_id=$2 WHERE account_id=$1',[row.account_id,row.id]);await this.release(db,row,target.reason??'CONFIGURATION_CHANGED');}return null;
    }
    const earlier=(await db.query(`SELECT 1 FROM app.action_intents WHERE account_id=$1 AND id<>$2 AND state=ANY($3::text[]) AND (created_at,campaign_id,step_no)<($4,$5,$6) LIMIT 1`,[row.account_id,row.id,[...pending,...inFlight,...unsafe],row.created_at,row.campaign_id,row.step_no])).rowCount;
    if(earlier){await this.defer(db,row,1,'ACCOUNT_FIFO');return null;}
    if(head.last_action_id&&head.last_action_id!==row.id&&(await this.action(db,head.last_action_id)).state!=='SUCCEEDED'){
      await this.transition(db,row,'CANCELLED','GLOBAL_PREDECESSOR_NOT_SUCCEEDED');return null;
    }
    const active=(await db.query('SELECT group_id,proxy_id FROM app.action_intents WHERE state=ANY($1::text[])',[inFlight])).rows;
    if(active.length>=this.concurrency||active.filter(a=>a.group_id===row.group_id).length>=target.policy.maxConcurrency||row.proxy_id&&active.some(a=>a.proxy_id===row.proxy_id)){await this.defer(db,row,1,'CONCURRENCY_LIMIT');return null;}
    const scopes=[{kind:'account',id:row.account_id},{kind:'group',id:row.group_id},...(row.proxy_id?[{kind:'proxy',id:row.proxy_id}]:[])];
    for(const scope of scopes){const recent=(await db.query('SELECT reserved_at FROM app.quota_reservations WHERE scope_kind=$1 AND scope_id=$2 AND reserved_at>$3 ORDER BY reserved_at',[scope.kind,scope.id,this.date(-3600)])).rows;
      if(recent.length>=target.policy.maxActionsHour){await this.defer(db,row,Math.max(1,(new Date(recent[recent.length-target.policy.maxActionsHour]!.reserved_at).getTime()-this.now())/1000+3600),'HOURLY_QUOTA');return null;}}
    const adapter=this.deps.adapters.get(row.spec.kind);if(!adapter||adapter.version!==row.adapter_version){await this.transition(db,row,'FAILED','ADAPTER_VERSION_CHANGED');return null;}
    const token=randomBytes(32).toString('base64url'),attempt=row.attempt_count+1,leaseEpoch=row.lease_epoch+1;
    await db.query('UPDATE app.action_intents SET lease_owner=$2,lease_token_hash=$3,lease_epoch=$4,lease_expires_at=$5,attempt_count=$6,execution_epoch=$7,dispatch_seq=COALESCE(dispatch_seq,$8),previous_execution_id=COALESCE(previous_execution_id,$9) WHERE id=$1',[row.id,owner,digest(token),leaseEpoch,this.date(this.leaseSeconds),attempt,head.epoch,head.next_seq,head.last_action_id===row.id?null:head.last_action_id]);
    await db.query('UPDATE app.execution_heads SET current_action_id=$2,last_action_id=$2,next_seq=next_seq+$3 WHERE account_id=$1',[row.account_id,row.id,row.dispatch_seq===null?1:0]);
    await db.query("UPDATE app.accounts SET runtime_state='AUTOMATING' WHERE id=$1",[row.account_id]);
    await db.query('INSERT INTO app.action_attempts(tenant_id,id,action_id,attempt_no,worker_id,lease_epoch,started_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.deps.tenantId,randomUUID(),row.id,attempt,owner,leaseEpoch,this.date()]);
    for(const scope of scopes)await db.query('INSERT INTO app.quota_reservations(tenant_id,action_id,attempt_no,scope_kind,scope_id,reserved_at) VALUES($1,$2,$3,$4,$5,$6)',[this.deps.tenantId,row.id,attempt,scope.kind,scope.id,this.date()]);
    await this.transition(db,row,'LEASED','ADMITTED');
    return {actionId:row.id,accountId:row.account_id,groupId:row.group_id,proxyId:row.proxy_id,attempt,leaseEpoch,token,owner,kind:row.spec.kind};
  });}
  private async leased(db:PoolClient,lease:Lease){
    const row=await this.action(db,lease.actionId);
    if(row.lease_owner!==lease.owner||row.lease_epoch!==lease.leaseEpoch||row.lease_token_hash!==digest(lease.token)||!row.lease_expires_at||row.lease_expires_at<=this.date()||!inFlight.includes(row.state))throw new WorkspaceError('LEASE_FENCED');
    const head=(await db.query('SELECT * FROM app.execution_heads WHERE account_id=$1',[row.account_id])).rows[0];
    if(head.epoch!==row.execution_epoch||head.current_action_id!==row.id)throw new WorkspaceError('LEASE_FENCED');return row;
  }
  async heartbeat(lease:Lease){await this.tx(async db=>{await this.leased(db,lease);await db.query('UPDATE app.action_intents SET lease_expires_at=$2 WHERE id=$1',[lease.actionId,this.date(this.leaseSeconds)]);});}
  async start(lease:Lease){await this.tx(async db=>{const row=await this.leased(db,lease);if(row.state!=='LEASED')throw new WorkspaceError('INVALID_TRANSITION');if(row.cancel_requested_at)throw new WorkspaceError('CANCEL_REQUESTED');await this.transition(db,row,'RUNNING','RUNNER_ACCEPTED');});}
  async beforeEffect(lease:Lease){await this.tx(async db=>{
    const row=await this.leased(db,lease);if(row.state!=='RUNNING')throw new WorkspaceError('INVALID_TRANSITION');
    const account=(await db.query('SELECT enabled,version FROM app.accounts WHERE id=$1',[row.account_id])).rows[0];
    const group=(await db.query('SELECT enabled,version FROM app.groups WHERE id=$1',[row.group_id])).rows[0];
    if(row.cancel_requested_at||!account.enabled||!group.enabled)throw new WorkspaceError('CANCEL_REQUESTED');
    const site=(await db.query('SELECT s.version FROM app.site_profiles s JOIN app.accounts a ON a.tenant_id=s.tenant_id AND a.site_id=s.id WHERE a.id=$1',[row.account_id])).rows[0];
    const proxy=row.proxy_id?(await db.query('SELECT version,enabled,deleted_at,state FROM app.proxies WHERE id=$1',[row.proxy_id])).rows[0]:null;
    if(account.version!==row.snapshot.accountVersion||group.version!==row.snapshot.groupVersion||site.version!==row.snapshot.siteVersion||proxy&&(proxy.version!==row.snapshot.proxyVersion||!proxy.enabled||proxy.deleted_at||proxy.state==='UNAVAILABLE'))throw new WorkspaceError('CONFIGURATION_CHANGED');
    if(row.latest_start<this.date())throw new WorkspaceError('DEADLINE_ELAPSED');
    await db.query('UPDATE app.action_attempts SET effect_sent_at=$3 WHERE action_id=$1 AND attempt_no=$2',[row.id,row.attempt_count,this.date()]);
    await db.query('UPDATE app.quota_reservations SET committed_at=$3 WHERE action_id=$1 AND attempt_no=$2',[row.id,row.attempt_count,this.date()]);
    await this.transition(db,row,'VERIFYING','EFFECT_INTENT_COMMITTED');
  });}
  private async safeRetry(db:PoolClient,row:Row,reason:string,retryAfter=0){
    // No external effect was authorized, or an adapter proved absence with replay safety.
    await db.query('DELETE FROM app.quota_reservations WHERE action_id=$1 AND attempt_no=$2 AND committed_at IS NULL',[row.id,row.attempt_count]);
    const backoff=(row.attempt_count===1?5:20)+randomBytes(1)[0]!/255;
    const delay=Math.max(backoff,Math.min(retryAfter,86400));
    const cancelled=row.cancel_requested_at||(await db.query('SELECT cancel_requested_at FROM app.campaigns WHERE id=$1',[row.campaign_id])).rows[0].cancel_requested_at;
    if(cancelled||row.attempt_count>=3||row.deadline<=this.date(delay)){
      await this.transition(db,row,cancelled?'CANCELLED':row.deadline<=this.date(delay)?'EXPIRED':'FAILED',cancelled?'CANCELLED_BEFORE_EFFECT':reason);await this.release(db,row,cancelled?'CANCELLED':reason);return;
    }
    await this.transition(db,row,'RETRY_WAIT',reason);await db.query('UPDATE app.action_intents SET earliest_start=$2,lease_expires_at=NULL,lease_token_hash=NULL WHERE id=$1',[row.id,this.date(delay)]);
    await db.query("UPDATE app.accounts SET runtime_state='DORMANT' WHERE id=$1",[row.account_id]);
  }
  async finish(lease:Lease,outcome:ExecutionOutcome){await this.tx(async db=>{
    const row=await this.leased(db,lease),attempt=(await db.query('SELECT * FROM app.action_attempts WHERE action_id=$1 AND attempt_no=$2',[row.id,row.attempt_count])).rows[0];
    const sent=attempt.effect_sent_at!==null;
    // A runner cannot call an effect successful without first persisting its intent.
    if(outcome.kind==='SUCCEEDED'&&!sent)throw new WorkspaceError('EFFECT_INTENT_REQUIRED');
    if(outcome.kind==='SUCCEEDED'){
      await this.transition(db,row,'SUCCEEDED',outcome.evidence?.code??'POSTCONDITION_CONFIRMED');await this.release(db,row,null);
    }else if(outcome.kind==='SAFE_RETRY'&&(!sent||row.replay_safe))await this.safeRetry(db,row,outcome.code,outcome.retryAfterSeconds);
    else if(outcome.kind==='FAILED'){
      if(!sent)await db.query('DELETE FROM app.quota_reservations WHERE action_id=$1 AND attempt_no=$2',[row.id,row.attempt_count]);
      await this.transition(db,row,'FAILED',outcome.code);await this.release(db,row,outcome.code);
    }else if(!sent)await this.safeRetry(db,row,'FAILED_BEFORE_EFFECT');
    else {await this.transition(db,row,'RECONCILING',outcome.kind==='UNCERTAIN'?outcome.code:'UNSAFE_RETRY_REJECTED');await this.release(db,row,'RECONCILING');}
    await db.query('UPDATE app.action_attempts SET finished_at=$3,outcome=$4,evidence=$5 WHERE action_id=$1 AND attempt_no=$2',[row.id,row.attempt_count,this.date(),outcome.kind,outcome.kind==='SUCCEEDED'&&outcome.evidence?outcome.evidence:null]);
    await this.refreshCampaigns(db);
  });}
  context(lease:Lease,signal:AbortSignal):ActionContext{return {actionId:lease.actionId,accountId:lease.accountId,groupId:lease.groupId,proxyId:lease.proxyId,attempt:lease.attempt,leaseEpoch:lease.leaseEpoch,signal,beforeEffect:()=>this.beforeEffect(lease)};}
  async reconcile(id:string,version?:number){
    const snapshot=await this.tx(async db=>{const row=await this.action(db,id,version);if(!unsafe.includes(row.state))throw new WorkspaceError('RECONCILIATION_NOT_REQUIRED');return row;});
    const adapter=this.deps.adapters.get(snapshot.spec.kind);
    const context={actionId:id,accountId:snapshot.account_id,groupId:snapshot.group_id,proxyId:snapshot.proxy_id,attempt:snapshot.attempt_count,leaseEpoch:snapshot.lease_epoch,signal:AbortSignal.timeout(10000)};
    let result:'SUCCEEDED'|'NOT_APPLIED'|'UNKNOWN'='UNKNOWN';
    if(adapter&&adapter.version===snapshot.adapter_version)try{result=await adapter.reconcile(context);}catch{}
    await this.tx(async db=>{
      const row=await this.action(db,id);if(row.version!==snapshot.version||!unsafe.includes(row.state))return;
      const predecessor=(await db.query('SELECT last_action_id FROM app.execution_heads WHERE account_id=$1',[row.account_id])).rows[0];
      if(predecessor.last_action_id!==id)throw new WorkspaceError('RECONCILIATION_FENCED');
      if(result==='SUCCEEDED'){await this.transition(db,row,'SUCCEEDED','RECONCILED_RECEIPT');await this.release(db,row,null);}
      else if(result==='NOT_APPLIED'&&row.replay_safe){await this.safeRetry(db,row,'RECONCILED_NOT_APPLIED');if(row.state==='RETRY_WAIT')await db.query('UPDATE app.execution_heads SET blocked_reason=NULL,current_action_id=$2 WHERE account_id=$1',[row.account_id,row.id]);}
      else if(row.state!=='UNKNOWN'){await this.transition(db,row,'UNKNOWN','INSUFFICIENT_EVIDENCE');await this.release(db,row,'UNKNOWN');}
      await this.audit(db,'engine.action.reconciled',id,'reconciler');await this.refreshCampaigns(db);
    });
  }
  private async reset(accountId:string,epoch:number,reason:string,requestId:string){
    const snapshot=await this.tx(async db=>{
      const head=(await db.query('SELECT * FROM app.execution_heads WHERE account_id=$1',[accountId])).rows[0];if(!head)throw new WorkspaceError('NOT_FOUND',404);
      if(head.epoch!==epoch)throw new WorkspaceError('VERSION_CONFLICT');
      if(!head.blocked_reason)throw new WorkspaceError('CHAIN_NOT_BLOCKED');
      if((await db.query('SELECT 1 FROM app.action_intents WHERE account_id=$1 AND state=ANY($2::text[])',[accountId,inFlight])).rowCount)throw new WorkspaceError('ACCOUNT_BUSY');
      return {head,action:head.last_action_id?await this.action(db,head.last_action_id):null};
    });
    let baseline:string|null='no-effect-in-flight';
    if(snapshot.action&&unsafe.includes(snapshot.action.state)){
      const adapter=this.deps.adapters.get(snapshot.action.spec.kind);
      baseline=adapter&&adapter.version===snapshot.action.adapter_version&&adapter.fenceAndBaseline?await adapter.fenceAndBaseline({actionId:snapshot.action.id,accountId,groupId:snapshot.action.group_id,proxyId:snapshot.action.proxy_id,attempt:snapshot.action.attempt_count,leaseEpoch:snapshot.action.lease_epoch,signal:AbortSignal.timeout(10000)}):null;
    }
    if(!baseline)throw new WorkspaceError('SAFE_BASELINE_REQUIRED');
    await this.tx(async db=>{
      const head=(await db.query('SELECT * FROM app.execution_heads WHERE account_id=$1',[accountId])).rows[0];
      if(head.epoch!==epoch||head.last_action_id!==snapshot.head.last_action_id)throw new WorkspaceError('VERSION_CONFLICT');
      if(snapshot.action&&(await this.action(db,snapshot.action.id)).version!==snapshot.action.version)throw new WorkspaceError('VERSION_CONFLICT');
      for(const row of (await db.query('SELECT * FROM app.action_intents WHERE account_id=$1 AND state=ANY($2::text[])',[accountId,[...pending,...unsafe]])).rows){
        await this.transition(db,row,unsafe.includes(row.state)?'ABANDONED':'CANCELLED',`CHAIN_RESET: ${reason}`);
      }
      await db.query('UPDATE app.execution_heads SET epoch=epoch+1,current_action_id=NULL,last_action_id=NULL,blocked_reason=NULL,baseline=$2 WHERE account_id=$1',[accountId,baseline]);
      await db.query("UPDATE app.accounts SET runtime_state='DORMANT' WHERE id=$1",[accountId]);
      await this.audit(db,'engine.chain.reset',accountId,requestId);await this.refreshCampaigns(db);
    });
  }
}
