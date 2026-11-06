import {createHash,createHmac} from 'node:crypto';
import type {EngineStep,PlanTarget} from '@msm/contracts';
import {WorkspaceError} from '../workspace/errors.js';

export interface TargetSnapshot extends PlanTarget {
  accountVersion:number;groupVersion:number;siteVersion:number;proxyId:string|null;proxyVersion:number|null;epoch:number;
  policy:{maxActionsHour:number;maxConcurrency:number};
}
export interface AdapterDescription {kind:EngineStep['kind'];version:string;estimatedSeconds:number;replaySafe:boolean;}
export interface PlanSnapshot {
  recipeId:string;recipeVersion:number;recipeName:string;steps:EngineStep[];adapters:AdapterDescription[];
  seed:string;mode:'distributed'|'immediate';windowSeconds:number;targets:TargetSnapshot[];estimatedSeconds:number;concurrency:number;
}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Pure simulation. Quotas use a sliding hour; 30% spare capacity is reserved. */
export function schedule(plan:PlanSnapshot,past:{kind:string;id:string;offset:number}[]=[]):PlanSnapshot {
  const targets=plan.targets.filter(t=>t.eligible).sort((a,b)=>digest(plan.seed+a.accountId).localeCompare(digest(plan.seed+b.accountId)));
  const slots=new Map<string,number[]>(),quota=new Map<string,number[]>();
  for(const item of past){const key=`${item.kind}:${item.id}`;quota.set(key,[...(quota.get(key)??[]),item.offset].sort((a,b)=>a-b));}
  const chainSeconds=plan.adapters.reduce((sum,a)=>sum+Math.ceil(a.estimatedSeconds/0.7),0);
  let finish=0;
  for(let rank=0;rank<targets.length;rank++){
    const target=targets[rank]!,random=createHmac('sha256',plan.seed).update(target.accountId).digest().readUInt32BE()/0x100000000;
    let start=plan.mode==='distributed'?Math.floor((rank+random)/targets.length*Math.max(0,plan.windowSeconds-chainSeconds)):0;
    const scopes=[{key:'global',concurrency:plan.concurrency}, {key:`group:${target.groupId}`,concurrency:Math.min(plan.concurrency,target.policy.maxConcurrency)},...(target.proxyId?[{key:`proxy:${target.proxyId}`,concurrency:1}]:[])];
    const limits=[`account:${target.accountId}`,`group:${target.groupId}`,...(target.proxyId?[`proxy:${target.proxyId}`]:[])];
    const offsets:number[]=[];
    for(const adapter of plan.adapters){
      const duration=Math.ceil(adapter.estimatedSeconds/0.7);
      for(let guard=0;guard<20001;guard++){
        let next=start;
        for(const scope of scopes){const busy=slots.get(scope.key)??Array(scope.concurrency).fill(0);next=Math.max(next,Math.min(...busy));}
        for(const key of limits){const within=(quota.get(key)??[]).filter(t=>t>start-3600);if(within.length>=target.policy.maxActionsHour)next=Math.max(next,within[within.length-target.policy.maxActionsHour]!+3600);}
        if(next===start)break;
        start=next;
        if(guard===20000)throw new WorkspaceError('PLAN_CAPACITY_EXCEEDED');
      }
      if(start+duration>plan.windowSeconds)throw new WorkspaceError('PLAN_CAPACITY_EXCEEDED');
      offsets.push(start);
      for(const scope of scopes){const busy=slots.get(scope.key)??Array(scope.concurrency).fill(0);busy[busy.indexOf(Math.min(...busy))]=start+duration;slots.set(scope.key,busy);}
      for(const key of limits)quota.set(key,[...(quota.get(key)??[]),start].sort((a,b)=>a-b));
      start+=duration;finish=Math.max(finish,start);
    }
    target.offsets=offsets;
  }
  return {...plan,estimatedSeconds:finish};
}
