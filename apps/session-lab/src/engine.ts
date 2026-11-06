import {chromium,type Browser,type BrowserContext,type Page,type CDPSession,type Locator} from 'playwright';
import {randomUUID,createHash,randomInt} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {request} from 'node:http';
import {Vault,decode,wipe,cryptoReady} from '@msm/crypto';
import {labCommandSchema,type LabCommand,type LabAccount,type LabStatus,type LabFrame,type LabStep,type LabResult,type LabActionResult,type LabPlan,type LabBatch,type LabMetrics,type Ciphertext} from '@msm/contracts';

export class LabError extends Error {constructor(public readonly code:string,public readonly status=409){super(code);}}
interface Active {context:BrowserContext;page:Page;cdp:CDPSession;frame:LabFrame|null;mode:'visible'|'background';}
interface Saved {url:string;storage:Awaited<ReturnType<BrowserContext['storageState']>>;sessionStorage:Record<string,string>;}
export interface LabConfig {tenantId:string;groupId:string;capability:string;}
const limits={visible:4,background:2,total:6} as const;
export function fixtureUrl(raw:string):string {
  let url:URL;try{url=new URL(raw);}catch{throw new LabError('URL_INVALID',400);}
  if(url.protocol!=='http:'||!['fixture.test','canvas.test'].includes(url.hostname)||url.port||url.username||url.password)throw new LabError('LAB_FIXTURE_ONLY',400);
  return url.href;
}
export class LabEngine {
  #browser:Browser|undefined;#launch:Promise<Browser>|undefined;#vault=new Vault(24*3600_000);#writes=Promise.resolve();
  #accounts=new Map<string,LabAccount>();#active=new Map<string,Active>();#opening=new Set<string>();
  #lanes=new Map<string,Promise<unknown>>();#plans=new Map<string,{plan:LabPlan;versions:number[];consumed?:string}>();
  #batches=new Map<string,LabBatch>();#tasks=new Set<Promise<void>>();
  #room:LabStatus['room']={accountIds:[],leaderId:null,mirror:false};
  #frames=0;#frameBytes=0;#latencies:number[]=[];#started=Date.now();#stopping=false;
  #idleTimer:ReturnType<typeof setTimeout>|undefined;
  constructor(readonly config:LabConfig,private readonly directory:string){}
  async initialize(key:string){
    await cryptoReady();const root=decode(key,32);try{this.#vault.unlock(root);}finally{wipe(root);}
    await mkdir(this.directory,{recursive:true,mode:0o700});
    try{
      const manifest=JSON.parse(await readFile(`${this.directory}/profiles.json`,'utf8')) as LabAccount[];
      for(const account of manifest){fixtureUrl(account.url);if(!/^[a-f0-9-]{36}$/.test(account.id))throw new Error('INVALID_PROFILE');this.#accounts.set(account.id,{...account,state:account.error==='RESULT_UNKNOWN'?'blocked':'dormant'});}
      const batches=JSON.parse(await readFile(`${this.directory}/batches.json`,'utf8')) as LabBatch[];
      for(const batch of batches)this.#batches.set(batch.id,{...batch,state:batch.state==='running'?'interrupted':batch.state});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new LabError('LAB_STATE_INVALID',503);}
  }
  async #save(name:string,value:unknown){const text=JSON.stringify(value);const task=this.#writes.catch(()=>{}).then(async()=>{await writeFile(`${this.directory}/${name}.next`,text,{mode:0o600});await rename(`${this.directory}/${name}.next`,`${this.directory}/${name}.json`);});this.#writes=task;return task;}
  #saveProfiles(){return this.#save('profiles',[...this.#accounts.values()].map(a=>({...a,state:a.error==='RESULT_UNKNOWN'?'blocked':'dormant'})));}
  #saveBatches(){return this.#save('batches',[...this.#batches.values()].slice(-20));}
  #account(id:string){const account=this.#accounts.get(id);if(!account)throw new LabError('PROFILE_NOT_FOUND',404);return account;}
  async #browserInstance(){if(this.#browser)return this.#browser;if(!this.#launch)this.#launch=chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,proxy:{server:'http://127.0.0.1:3138'}});try{this.#browser=await this.#launch;return this.#browser;}finally{this.#launch=undefined;}}
  async #lane<T>(id:string,work:()=>Promise<T>):Promise<T>{
    const previous=this.#lanes.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(work);this.#lanes.set(id,next);
    try{return await next;}finally{if(this.#lanes.get(id)===next)this.#lanes.delete(id);}
  }
  async #open(id:string,mode:'visible'|'background'='visible'){
    clearTimeout(this.#idleTimer);
    const account=this.#account(id), existing=this.#active.get(id);if(existing)return existing;
    if(account.error==='RESULT_UNKNOWN')throw new LabError('PROFILE_BLOCKED');
    if(this.#active.size+this.#opening.size>=limits.total)throw new LabError('CONTEXT_LIMIT');
    if(mode==='visible'&&[...this.#active.values()].filter(a=>a.mode==='visible').length+this.#opening.size>=limits.visible)throw new LabError('VISIBLE_LIMIT');
    this.#opening.add(id);account.state='opening';let context:BrowserContext|undefined;
    try{
      let saved:Saved|undefined;
      if(account.hasSnapshot){
        const envelope=JSON.parse(await readFile(`${this.directory}/${id}.json`,'utf8')) as Ciphertext;
        let bytes:Uint8Array;try{bytes=this.#vault.open(envelope,{tenantId:this.config.tenantId,groupId:this.config.groupId,entityId:id,purpose:'session'});}catch{throw new LabError('SNAPSHOT_INTEGRITY_FAILED');}
        try{saved=JSON.parse(new TextDecoder().decode(bytes)) as Saved;}finally{wipe(bytes);}
        if(saved.url!==account.url)throw new LabError('SNAPSHOT_SITE_MISMATCH');
      }
      context=await(await this.#browserInstance()).newContext({viewport:{width:720,height:480},...(saved?{storageState:saved.storage}:{})});
      if(saved)await context.addInitScript(({origin,values})=>{if(location.origin===origin)for(const [key,value]of Object.entries(values))sessionStorage.setItem(key,value);},{origin:new URL(account.url).origin,values:saved.sessionStorage});
      const page=await context.newPage();
      await page.goto(account.url,{waitUntil:'domcontentloaded',timeout:10000});
      const cdp=await context.newCDPSession(page);const active:Active={context,page,cdp,frame:null,mode};this.#active.set(id,active);
      let seq=0;
      const acknowledgements=new Set<ReturnType<typeof setTimeout>>();
      page.on('close',()=>{for(const timer of acknowledgements)clearTimeout(timer);acknowledgements.clear();});
      cdp.on('Page.screencastFrame',event=>{
        // Delay the producer acknowledgement instead of skipping compositor frames:
        // a static page may never produce the eighth frame, including its login form.
        const timer=setTimeout(()=>{acknowledgements.delete(timer);void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});},250);
        timer.unref();acknowledgements.add(timer);
        const now=Date.now();
        active.frame={accountId:id,sequence:++seq,createdAt:now,width:720,height:480,jpeg:event.data};this.#frames++;this.#frameBytes+=Math.ceil(event.data.length*0.75);
      });
      await cdp.send('Page.startScreencast',{format:'jpeg',quality:58,maxWidth:720,maxHeight:480,everyNthFrame:1});
      account.state=mode;delete account.error;return active;
    }catch(error){if(context)await context.close().catch(()=>{});account.state='blocked';account.error=error instanceof LabError?error.code:'BROWSER_OPEN_FAILED';throw new LabError(account.error);}
    finally{this.#opening.delete(id);}
  }
  async #checkpoint(id:string){
    const account=this.#account(id),active=this.#active.get(id);if(!active)throw new LabError('PROFILE_NOT_OPEN');
    const storage=await active.context.storageState({indexedDB:true});
    const sessionStorage=await active.page.evaluate(()=>Object.fromEntries(Object.entries(window.sessionStorage)));
    const bytes=new TextEncoder().encode(JSON.stringify({url:account.url,storage,sessionStorage} satisfies Saved));
    try{const encrypted=this.#vault.seal(bytes,{tenantId:this.config.tenantId,groupId:this.config.groupId,entityId:id,purpose:'session'});await this.#save(id,encrypted);}finally{wipe(bytes);}
    account.hasSnapshot=true;await this.#saveProfiles();
  }
  async #close(id:string){
    const active=this.#active.get(id);if(!active)return;
    await this.#checkpoint(id);await active.cdp.send('Page.stopScreencast').catch(()=>{});await active.context.close();this.#active.delete(id);this.#account(id).state=this.#account(id).error==='RESULT_UNKNOWN'?'blocked':'dormant';
    this.#room.accountIds=this.#room.accountIds.filter(x=>x!==id);if(this.#room.leaderId===id){this.#room.leaderId=null;this.#room.mirror=false;}await this.#saveProfiles();
    if(!this.#active.size){clearTimeout(this.#idleTimer);this.#idleTimer=setTimeout(()=>{if(!this.#active.size&&!this.#opening.size&&!this.#tasks.size){const browser=this.#browser;this.#browser=undefined;void browser?.close();}},1000);this.#idleTimer.unref();}
  }
  #locator(page:Page,target:{by:'testId'|'css';value:string}):Locator{return target.by==='testId'?page.getByTestId(target.value):page.locator(target.value);}
  async #sensitive(locator:Locator){return locator.evaluate(el=>!!el.closest('form')?.querySelector('input[type="password"]')||el.getAttribute('type')==='password');}
  async #perform(id:string,step:LabStep){
    const active=this.#active.get(id);if(!active)throw new LabError('PROFILE_NOT_OPEN');const {page}=active;
    if(step.kind==='navigate'){
      const url=fixtureUrl(step.url);if(new URL(url).origin!==new URL(this.#account(id).url).origin)throw new LabError('SITE_MISMATCH');await page.goto(url,{waitUntil:'domcontentloaded'});return;
    }
    const target=this.#locator(page,step.target);if(await target.count()!==1)throw new LabError('TARGET_NOT_UNIQUE');
    if(step.kind==='assert'){
      await page.waitForFunction(({target,text})=>{const el=target.by==='testId'?document.querySelector(`[data-testid="${CSS.escape(target.value)}"]`):document.querySelector(target.value);return el?.textContent?.includes(text);},{target:step.target,text:step.text},{timeout:3000});return;
    }
    if(step.kind==='fill'){if(await this.#sensitive(target))throw new LabError('SENSITIVE_RECIPE_FORBIDDEN');await target.fill(step.value);return;}
    const testId=await target.getAttribute('data-testid');await target.click({timeout:3000});
    if(testId==='login'){await page.getByTestId('identity').waitFor({state:'visible',timeout:3000});return;}
    if(['heal','shop','reject','save-note','canvas'].includes(testId??'')){
      await page.waitForFunction(()=>{const text=document.querySelector('[data-testid="result"]')?.textContent;return text?.startsWith('OK:')||text?.startsWith('Erro:');},null,{timeout:3000});
      if((await page.getByTestId('result').innerText()).startsWith('Erro:'))throw new LabError('BUSINESS_REJECTED');
    }
  }
  async #effect(id:string,step:LabStep):Promise<LabActionResult>{
    const began=performance.now();try{await this.#perform(id,step);if(step.kind!=='assert')this.#account(id).version++;return {accountId:id,state:'succeeded',durationMs:performance.now()-began};}
    catch(error){const code=error instanceof LabError?error.code:'RESULT_UNKNOWN';const state=code==='RESULT_UNKNOWN'?'unknown':'failed';const account=this.#account(id);account.error=code;if(state==='unknown')account.state='blocked';return {accountId:id,state,durationMs:performance.now()-began,code};}
  }
  async #apply(id:string,step:LabStep,mirror:boolean):Promise<LabActionResult[]>{
    const account=this.#account(id);if(account.state==='blocked')throw new LabError('PROFILE_BLOCKED');
    const first=await this.#lane(id,()=>this.#effect(id,step));const results=[first];
    if(first.state==='succeeded'&&mirror&&this.#room.mirror){
      if(this.#room.leaderId!==id)throw new LabError('LEADER_REQUIRED');
      const started=performance.now();const followers=this.#room.accountIds.filter(x=>x!==id);
      const others=await Promise.all(followers.map(target=>this.#lane(target,async()=>{this.#latencies.push(performance.now()-started);return this.#effect(target,step);})));results.push(...others);
      if(others.some(result=>result.state!=='succeeded'))this.#room.mirror=false;
    }
    this.#latencies=this.#latencies.slice(-300);return results;
  }
  async #input(command:Extract<LabCommand,{kind:'input'}>){
    if(this.#account(command.accountId).error==='RESULT_UNKNOWN')throw new LabError('PROFILE_BLOCKED');
    const active=this.#active.get(command.accountId);if(!active)throw new LabError('PROFILE_NOT_OPEN');const {page}=active;const input=command.input;
    if(input.type==='key'){await this.#lane(command.accountId,()=>page.keyboard.press(input.key));return {};}
    if(input.type==='scroll'){await this.#lane(command.accountId,()=>page.mouse.wheel(0,input.deltaY));return {};}
    const descriptor=await page.evaluate(({input})=>{
      const raw=input.type==='click'?document.elementFromPoint(input.x,input.y):document.activeElement;
      const el=raw?.closest('button,a,input,textarea,canvas,[role="button"]');if(!el)return null;
      const testId=el.getAttribute('data-testid'),id=el.id;
      const target=testId?{by:'testId' as const,value:testId}:id?{by:'css' as const,value:`#${CSS.escape(id)}`} :null;
      return target?{target,sensitive:!!el.closest('form')?.querySelector('input[type="password"]')||el.getAttribute('type')==='password',canvas:el.tagName==='CANVAS'}:null;
    },{input});
    if(!descriptor)throw new LabError('INPUT_TARGET_UNSUPPORTED');
    if(input.type==='text'&&descriptor.sensitive){await this.#lane(command.accountId,()=>this.#locator(page,descriptor.target).fill(input.value));return {};}
    const step:LabStep=input.type==='click'?{kind:'click',target:descriptor.target}:{kind:'fill',target:descriptor.target,value:input.value};
    const mirror=this.#room.mirror&&this.#room.leaderId===command.accountId&&!descriptor.sensitive&&!descriptor.canvas;
    return {results:await this.#apply(command.accountId,step,mirror),...(!descriptor.sensitive&&!descriptor.canvas?{recordedStep:step}:{})};
  }
  async metrics():Promise<LabMetrics>{
    let rssBytes=0,memoryBytes=0,cpuMs=0;
    for(const pid of(await readdir('/proc')).filter(s=>/^\d+$/.test(s))){try{const value=(await readFile(`/proc/${pid}/status`,'utf8')).match(/^VmRSS:\s+(\d+)/m)?.[1];rssBytes+=Number(value??0)*1024;}catch{}}
    try{memoryBytes=Number(await readFile('/sys/fs/cgroup/memory.current','utf8'));const raw=await readFile('/sys/fs/cgroup/cpu.stat','utf8');cpuMs=Number(raw.match(/usage_usec (\d+)/)?.[1]??0)/1000;}catch{}
    return {rssBytes,memoryBytes,cpuMs,contexts:new Set([...this.#active.keys(),...this.#opening]).size,frames:this.#frames,frameBytes:this.#frameBytes,latencyMs:[...this.#latencies],uptimeSeconds:(Date.now()-this.#started)/1000};
  }
  async status():Promise<LabStatus>{return {available:true,accounts:[...this.#accounts.values()].map(a=>({...a})),room:{...this.#room,accountIds:[...this.#room.accountIds]},batches:[...this.#batches.values()],metrics:await this.metrics(),limits};}
  frame(id:string){this.#account(id);return this.#active.get(id)?.frame??null;}
  async #runBatch(batch:LabBatch,plan:LabPlan){
    let cursor=0;const start=Date.now();const worker=async()=>{
      while(cursor<plan.accountIds.length&&!batch.cancelRequested){const index=cursor++,id=plan.accountIds[index]!;const due=start+Math.floor(index*plan.windowSeconds*1000/plan.accountIds.length);
        while(due>Date.now()&&!batch.cancelRequested)await new Promise(resolve=>setTimeout(resolve,Math.min(100,due-Date.now())));if(batch.cancelRequested)break;
        await this.#lane(id,async()=>{
          const existing=this.#active.has(id);try{
            await this.#open(id,'background');
            for(const step of plan.steps){if(batch.cancelRequested)break;const result=await this.#effect(id,step);batch.results.push(result);batch.completed++;if(result.state!=='succeeded')break;}
            await this.#checkpoint(id);
          }catch(error){batch.results.push({accountId:id,state:'failed',durationMs:0,code:error instanceof LabError?error.code:'EXECUTION_FAILED'});}
          finally{if(!existing&&this.#active.has(id))await this.#close(id);}
        });await this.#saveBatches();
      }
    };
    try{await Promise.all([worker(),worker()]);batch.state=batch.cancelRequested?'cancelled':batch.results.some(r=>r.state!=='succeeded')?'partial':'completed';}
    catch{batch.state='interrupted';}finally{await this.#saveBatches();}
  }
  async command(raw:LabCommand):Promise<LabResult>{
    const command=labCommandSchema.parse(raw);if(this.#stopping)throw new LabError('LAB_STOPPING');let extra:Omit<LabResult,'status'>={};
    switch(command.kind){
      case 'create':{if(this.#accounts.size>=12)throw new LabError('PROFILE_LIMIT');const account:LabAccount={id:randomUUID(),label:command.label,url:fixtureUrl(command.url),state:'dormant',hasSnapshot:false,version:1};this.#accounts.set(account.id,account);await this.#saveProfiles();extra={accountId:account.id};break;}
      case 'open':await this.#lane(command.accountId,()=>this.#open(command.accountId));break;
      case 'close':await this.#lane(command.accountId,()=>this.#close(command.accountId));break;
      case 'checkpoint':await this.#lane(command.accountId,()=>this.#checkpoint(command.accountId));break;
      case 'room':{
        if(new Set(command.accountIds).size!==command.accountIds.length||!command.accountIds.includes(command.leaderId))throw new LabError('INVALID_ROOM',400);
        const origin=new URL(this.#account(command.leaderId).url).origin;
        for(const id of command.accountIds)if(new URL(this.#account(id).url).origin!==origin||!this.#active.has(id))throw new LabError('ROOM_SITE_MISMATCH');
        this.#room={accountIds:[...command.accountIds],leaderId:command.leaderId,mirror:command.mirror};break;
      }
      case 'input':extra=await this.#input(command);break;
      case 'step':{
        if(command.mirror&&this.#room.leaderId!==command.accountId)throw new LabError('LEADER_REQUIRED');
        const active=this.#active.get(command.accountId);if(!active)throw new LabError('PROFILE_NOT_OPEN');
        const sensitive=command.step.kind!=='navigate'&&await this.#sensitive(this.#locator(active.page,command.step.target));
        extra={results:await this.#apply(command.accountId,command.step,command.mirror&&!sensitive),...(!sensitive?{recordedStep:command.step}:{})};break;
      }
      case 'simulate':{
        if(new Set(command.accountIds).size!==command.accountIds.length)throw new LabError('DUPLICATE_TARGET',400);
        const profiles=command.accountIds.map(id=>this.#account(id));const origin=new URL(profiles[0]!.url).origin;
        if(profiles.some(a=>new URL(a.url).origin!==origin||a.state==='blocked'))throw new LabError('PLAN_INCOMPATIBLE');
        if(command.steps.some(step=>step.kind==='navigate'&&new URL(fixtureUrl(step.url)).origin!==origin))throw new LabError('SITE_MISMATCH');
        const plan:LabPlan={id:randomUUID(),hash:'',accountIds:[...command.accountIds],steps:structuredClone(command.steps),actionCount:command.accountIds.length*command.steps.length,windowSeconds:command.windowSeconds,expiresAt:Date.now()+60000};
        plan.hash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');this.#plans.set(plan.id,{plan,versions:profiles.map(a=>a.version)});extra={plan};break;
      }
      case 'confirm':{
        const entry=this.#plans.get(command.planId);if(!entry||entry.plan.hash!==command.hash)throw new LabError('PLAN_INVALID');
        if(entry.consumed){extra={batchId:entry.consumed};break;}
        if(entry.plan.expiresAt<Date.now()||entry.plan.accountIds.some((id,index)=>this.#account(id).version!==entry.versions[index]))throw new LabError('PLAN_EXPIRED');
        const batch:LabBatch={id:randomUUID(),state:'running',total:entry.plan.actionCount,completed:0,results:[],cancelRequested:false};entry.consumed=batch.id;this.#batches.set(batch.id,batch);await this.#saveBatches();
        const task=this.#runBatch(batch,entry.plan);this.#tasks.add(task);void task.finally(()=>this.#tasks.delete(task));extra={batchId:batch.id};break;
      }
      case 'cancel':{const batch=this.#batches.get(command.batchId);if(!batch)throw new LabError('BATCH_NOT_FOUND',404);batch.cancelRequested=true;await this.#saveBatches();break;}
      case 'restartBrowser':{
        if(this.#tasks.size)throw new LabError('BATCH_RUNNING');for(const id of [...this.#active.keys()])await this.#lane(id,()=>this.#close(id));await this.#browser?.close();this.#browser=undefined;break;
      }
    }
    return {status:await this.status(),...extra};
  }
  async inspect(id:string){
    const active=this.#active.get(id);if(!active){
      const account=this.#account(id);if(!account.hasSnapshot)throw new LabError('SNAPSHOT_REQUIRED');
      const envelope=JSON.parse(await readFile(`${this.directory}/${id}.json`,'utf8')) as Ciphertext;
      const bytes=this.#vault.open(envelope,{tenantId:this.config.tenantId,groupId:this.config.groupId,entityId:id,purpose:'session'});
      let saved:Saved;try{saved=JSON.parse(new TextDecoder().decode(bytes));}finally{wipe(bytes);}
      const url=new URL(account.url);url.pathname='/api/me';url.search='';
      const cookie=saved.storage.cookies.filter(c=>c.domain===url.hostname).map(c=>`${c.name}=${c.value}`).join('; ');
      return new Promise<{authenticated:boolean;user:{username:string;heals:number;visits:number;canvasClicks:number;note:string}}>((resolve,reject)=>{
        const req=request({hostname:'127.0.0.1',port:3138,path:url.href,headers:{cookie}},res=>{let text='';res.on('data',chunk=>{text+=chunk;if(text.length>16384)res.destroy();});res.on('end',()=>{try{resolve({authenticated:res.statusCode===200,user:JSON.parse(text)});}catch{reject(new LabError('HEALTH_RESPONSE_INVALID'));}});res.on('error',reject);});
        req.setTimeout(3000,()=>req.destroy());req.on('error',reject);req.end();
      });
    }
    return active.page.evaluate(async()=>{
      const response=await fetch('/api/me');const user=await response.json();
      const indexedDBUser=await new Promise<string|null>(resolve=>{const req=indexedDB.open('msm-fixture',1);req.onupgradeneeded=()=>req.result.createObjectStore('markers');req.onerror=()=>resolve(null);req.onsuccess=()=>{const db=req.result,tx=db.transaction('markers','readonly'),get=tx.objectStore('markers').get('user');get.onsuccess=()=>resolve(get.result??null);tx.oncomplete=()=>db.close();};});
      const pixels=document.querySelector('canvas')?.getContext('2d')?.getImageData(20,20,1,1).data;
      return {authenticated:response.ok,user,localStorageUser:localStorage.getItem('fixture-user'),sessionStorageUser:sessionStorage.getItem('fixture-tab'),indexedDBUser,canvasFrame:document.querySelector('[data-testid="canvas-ready"]')?.textContent,canvasPixel:pixels?[...pixels]:null};
    });
  }
  async bounds(id:string,testId:string){const active=this.#active.get(id);if(!active)throw new LabError('PROFILE_NOT_OPEN');await active.page.getByTestId(testId).scrollIntoViewIfNeeded();return active.page.getByTestId(testId).boundingBox();}
  async shutdown(){this.#stopping=true;clearTimeout(this.#idleTimer);for(const batch of this.#batches.values())if(batch.state==='running')batch.cancelRequested=true;await Promise.allSettled(this.#tasks);for(const id of [...this.#active.keys()])await this.#close(id).catch(()=>{});clearTimeout(this.#idleTimer);await this.#browser?.close();await this.#writes;this.#vault.lock();}
}
