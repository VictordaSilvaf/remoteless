import {randomUUID} from 'node:crypto';
import {Queue,Worker} from 'bullmq';
import {z} from 'zod';
import type {RedisOptions} from 'bullmq';
import type {EngineService,Lease} from './service.js';

const ticket=z.object({version:z.literal(1),eventId:z.uuid(),actionId:z.uuid()}).strict();
export class EngineRuntime {
  private readonly queue:Queue;
  private readonly worker:Worker;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private stopping=false;
  private activeTick:Promise<void>|undefined;
  private readonly owner=randomUUID();
  private readonly controllers=new Set<AbortController>();
  constructor(readonly engine:EngineService,connection:RedisOptions,private readonly logError?:(phase:string,code:string)=>void){
    const name=`msm-actions-${engine.deps.tenantId}`;
    const {commandTimeout:_blockingTimeout,...workerConnection}=connection;
    this.queue=new Queue(name,{connection:{...connection,maxRetriesPerRequest:1,enableOfflineQueue:false},defaultJobOptions:{attempts:1,removeOnComplete:{count:0},removeOnFail:{age:3600,count:1000}}});
    this.worker=new Worker(name,async job=>{
      const data=ticket.parse(job.data);
      const lease=await engine.claim(data.eventId,data.actionId,this.owner);if(!lease)return;
      await this.execute(lease);
    },{connection:{...workerConnection,maxRetriesPerRequest:null},concurrency:engine.concurrency,autorun:false,maxStalledCount:1});
    this.queue.on('error',error=>{engine.runtime.queue='unavailable';this.failure('queue',error);});
    this.worker.on('error',error=>{engine.runtime.queue='unavailable';this.failure('worker',error);});
    this.worker.on('failed',(job,error)=>{this.failure('delivery',error);const parsed=ticket.safeParse(job?.data);if(parsed.success)void engine.deliveryFailed(parsed.data.eventId,parsed.data.actionId).catch(error=>this.failure('delivery-recovery',error));});
  }
  private failure(phase:string,error:unknown){const candidate=(error as {code?:unknown})?.code;const code=typeof candidate==='string'&&/^[A-Z0-9_]{3,80}$/.test(candidate)?candidate:'ENGINE_OPERATION_FAILED';this.engine.runtime.lastError=`${phase}:${code}`;this.logError?.(phase,code);}
  start(){
    this.engine.runtime.available=true;
    void this.worker.run().catch(error=>{this.engine.runtime.available=false;this.failure('worker-start',error);});
    this.loop();
  }
  private loop(){if(this.stopping)return;this.activeTick=this.cycle().finally(()=>{this.activeTick=undefined;if(!this.stopping)this.timer=setTimeout(()=>this.loop(),500);});}
  async cycle(){
    try {
      for(const id of await this.engine.tick())await this.engine.reconcile(id);
      await this.queue.getWaitingCount();
      for(const event of await this.engine.tickets()){
        const existing=await this.queue.getJob(event.id);
        if(existing&&['failed','completed'].includes(await existing.getState()))await existing.remove();
        await this.queue.add('action',{version:1,eventId:event.id,actionId:event.entity_id},{jobId:event.id});
        // Publication and acknowledgement deliberately straddle the Redis/SQL boundary.
        await this.engine.published(event.id);
      }
      this.engine.runtime.queue='healthy';
    }catch(error){this.engine.runtime.queue='unavailable';this.failure('dispatch',error);}
  }
  private async execute(lease:Lease){
    const controller=new AbortController();this.controllers.add(controller);
    // All phase 3 adapters are bounded. A timed out effect is reconciled, never retried blindly.
    const timeout=setTimeout(()=>controller.abort(),12000);
    let heartbeat:ReturnType<typeof setTimeout>|undefined;
    const beat=async()=>{try{await this.engine.heartbeat(lease);if(!controller.signal.aborted)heartbeat=setTimeout(()=>void beat(),Math.floor(this.engine.leaseSeconds*1000/3));}catch{controller.abort();}};
    heartbeat=setTimeout(()=>void beat(),Math.floor(this.engine.leaseSeconds*1000/3));
    try {
      await this.engine.start(lease);
      controller.signal.throwIfAborted();
      const adapter=this.engine.deps.adapters.get(lease.kind)!;
      const aborted=new Promise<never>((_resolve,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('EXECUTION_INTERRUPTED')),{once:true});});
      // Attach a rejection handler through race, even if a late adapter resolves after fencing.
      const outcome=await Promise.race([adapter.execute(this.engine.context(lease,controller.signal)),aborted]);
      await this.engine.finish(lease,outcome);
    }catch{
      await this.engine.finish(lease,{kind:'UNCERTAIN',code:'EXECUTION_INTERRUPTED'}).catch(()=>{});
    }finally{clearTimeout(timeout);clearTimeout(heartbeat);controller.abort();this.controllers.delete(controller);}
  }
  async close(){
    this.stopping=true;this.engine.runtime.available=false;clearTimeout(this.timer);
    for(const controller of this.controllers)controller.abort();
    await this.activeTick;
    await this.worker.close();await this.queue.close();
  }
}
