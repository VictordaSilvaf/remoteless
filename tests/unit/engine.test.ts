import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {engineCommandSchema} from '@msm/contracts';
import {schedule,canonical,digest,type PlanSnapshot,type TargetSnapshot} from '../../apps/local-api/src/engine/planner.js';

function target(groupId:string):TargetSnapshot{return {accountId:randomUUID(),alias:'Conta',groupId,eligible:true,reason:null,offsets:[],accountVersion:1,groupVersion:1,siteVersion:1,proxyId:null,proxyVersion:null,epoch:1,policy:{maxActionsHour:10000,maxConcurrency:2}};}
function plan(count=10):PlanSnapshot{const groups=[randomUUID(),randomUUID()];return {recipeId:randomUUID(),recipeVersion:1,recipeName:'Teste',steps:[{kind:'account.inspect'},{kind:'account.inspect'}],adapters:Array.from({length:2},()=>({kind:'account.inspect' as const,version:'v1',estimatedSeconds:1,replaySafe:true})),seed:'fixed-seed',mode:'distributed',windowSeconds:3600,targets:Array.from({length:count},(_,i)=>target(groups[i%2]!)),estimatedSeconds:0,concurrency:4};}
test('planner freezes a deterministic, capacity-bounded schedule for 500 accounts without I/O',()=>{
  const original=plan(500),a=schedule(structuredClone(original)),b=schedule(structuredClone(original));assert.deepEqual(a,b);
  assert.ok(a.targets.every(t=>t.offsets[1]!>=t.offsets[0]!+2&&t.offsets[1]!+2<=3600));
  const events=a.targets.flatMap(t=>t.offsets.flatMap(time=>[{time,change:1,group:t.groupId},{time:time+2,change:-1,group:t.groupId}])).sort((a,b)=>a.time-b.time||a.change-b.change);
  let busy=0;const groups=new Map<string,number>();for(const e of events){busy+=e.change;groups.set(e.group,(groups.get(e.group)??0)+e.change);assert.ok(busy<=4);assert.ok(groups.get(e.group)!<=2);}
  assert.ok(new Set(a.targets.map(t=>t.offsets[0])).size>100);
  assert.equal(digest(canonical({b:1,a:[2,3]})),digest(canonical({a:[2,3],b:1})));
});
test('planner enforces rolling-hour quotas, earlier usage and infeasible deadlines',()=>{
  const value=plan(1);value.mode='immediate';value.windowSeconds=7200;value.targets[0]!.policy.maxActionsHour=1;
  const result=schedule(value,[{kind:'group',id:value.targets[0]!.groupId,offset:-10}]);assert.equal(result.targets[0]!.offsets[0],3590);assert.equal(result.targets[0]!.offsets[1],7190);
  const impossible=plan(1);impossible.targets[0]!.policy.maxActionsHour=1;assert.throws(()=>schedule(impossible),/PLAN_CAPACITY_EXCEEDED/);
});
test('engine commands reject tenant selection, arbitrary code, unknown adapters and hidden credentials',()=>{
  for(const command of [{kind:'get',tenantId:randomUUID()},{kind:'recipe.save',name:'Code',steps:[{kind:'eval',code:'fetch(secret)'}]},{kind:'recipe.save',name:'Secret',steps:[{kind:'account.inspect',password:'secret'}]},{kind:'plan.confirm',id:randomUUID(),hash:'a'.repeat(64),token:'x'.repeat(43),idempotencyKey:randomUUID(),success:true}])assert.equal(engineCommandSchema.safeParse(command).success,false);
});
