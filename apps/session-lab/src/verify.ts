import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {resolve,sep,extname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {chromium,type Browser,type Page} from 'playwright';
import type {LabCommand,LabResult,LabMetrics,LabStep} from '@msm/contracts';
import {LabClient} from './client.js';

const config=JSON.parse(await readFile('/run/lab/config.json','utf8')) as {capability:string};
const client=new LabClient('/run/msm/lab/control.sock',config.capability);
const phase=process.env.MSM_VERIFY_STAGE??'prepare';
interface Observation {authenticated:boolean;user:{username:string;heals:number;visits:number;canvasClicks:number;note:string};localStorageUser?:string;sessionStorageUser?:string;indexedDBUser?:string;canvasFrame?:string;canvasPixel?:number[];}
interface Case {name:string;passed:boolean;durationMs:number;}
const cases:Case[]=[],samples:{phase:string;at:number;metrics:LabMetrics}[]=[];
const began=Date.now();
const mirrorRoundTrips:number[]=[];
async function check(name:string,work:()=>Promise<void>){const start=performance.now();await work();cases.push({name,passed:true,durationMs:performance.now()-start});console.log(`PASS ${name}`);}
async function command(input:LabCommand){return client.command(input);}
const inspect=(id:string)=>client.call<Observation>(`/inspect/${id}`);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(get:()=>Promise<T>,accept:(value:T)=>boolean,timeout=15000):Promise<T>{const end=Date.now()+timeout;while(Date.now()<end){const value=await get();if(accept(value))return value;await pause(120);}throw Error('CONDITION_TIMEOUT');}
async function closeAll(){for(const account of(await client.status()).accounts)if(['visible','background','blocked'].includes(account.state)){try{await command({kind:'close',accountId:account.id});}catch{}}}
async function point(id:string,testId:string){const box=await client.call<{x:number;y:number;width:number;height:number}>('/bounds',{accountId:id,testId});return {x:Math.max(0,Math.min(719,box.x+box.width/2)),y:Math.max(0,Math.min(479,box.y+box.height/2))};}
async function click(id:string,testId:string){return command({kind:'input',accountId:id,input:{type:'click',...await point(id,testId)}});}
async function login(id:string,username:string){
  await click(id,'username');await command({kind:'input',accountId:id,input:{type:'text',value:username}});
  await click(id,'password');const filled=await command({kind:'input',accountId:id,input:{type:'text',value:'phase0-demo'}});assert.equal(filled.recordedStep,undefined);
  const submitted=await click(id,'login');assert.equal(submitted.recordedStep,undefined);assert.equal(submitted.results?.[0]?.state,'succeeded');
  await until(()=>inspect(id),value=>value.authenticated&&value.indexedDBUser===username);
}
async function sample(name:string,duration=1400){const end=Date.now()+duration;while(Date.now()<end){const metrics=(await client.status()).metrics;samples.push({phase:name,at:Date.now(),metrics});assert.ok(metrics.contexts<=6);await pause(250);}}
async function batchDone(id:string){return until(async()=>(await client.status()).batches.find(b=>b.id===id)!,batch=>batch.state!=='running',60000);}
async function fixtureAccount(label:string,url='http://fixture.test/'){const result=await command({kind:'create',label,url});assert.ok(result.accountId);return result.accountId;}
let uiBrowser:Browser|undefined;
let uiServer:ReturnType<typeof createServer>|undefined;
async function viewer():Promise<Page>{
  const root=resolve('apps/session-lab/dist/viewer');
  uiServer=createServer(async(req,res)=>{try{const path=resolve(root,`.${new URL(req.url??'/','http://localhost').pathname==='/'?'/index.html':new URL(req.url??'/','http://localhost').pathname}`);if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}const data=await readFile(path);res.writeHead(200,{'content-type':extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html'});res.end(data);}catch{res.writeHead(404).end();}});
  await new Promise<void>(done=>uiServer!.listen(0,'127.0.0.1',done));
  const port=(uiServer.address() as {port:number}).port;
  uiBrowser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true});
  const page=await uiBrowser.newPage({viewport:{width:1440,height:1100}});
  await page.exposeBinding('labStatus',()=>client.status());
  await page.exposeBinding('labCommand',(_source,input:LabCommand)=>client.command(input));
  await page.exposeBinding('labFrame',(_source,id:string)=>client.frame(id));
  await page.addInitScript(()=>{const bridge=window as unknown as {labPort:unknown;labStatus:()=>Promise<unknown>;labCommand:(input:unknown)=>Promise<unknown>;labFrame:(id:string)=>Promise<unknown>};bridge.labPort={status:()=>bridge.labStatus(),command:(input:unknown)=>bridge.labCommand(input),frame:(id:string)=>bridge.labFrame(id)};});
  await page.goto(`http://127.0.0.1:${port}/`);return page;
}
async function uiClick(page:Page,id:string,target:string){
  const position=await point(id,target);const image=page.getByTestId(`frame-${id}`);const box=await image.boundingBox();assert.ok(box);
  await image.click({position:{x:position.x/720*box.width,y:position.y/480*box.height}});await pause(180);
}
try{
  if(phase==='prepare'){
    await check('empty-state-and-no-direct-egress',async()=>{
      assert.equal((await client.status()).accounts.length,0);
      const connected=await new Promise<boolean>(done=>{const socket=createConnection({host:'1.1.1.1',port:443});socket.setTimeout(800);socket.once('connect',()=>{socket.destroy();done(true);});socket.once('timeout',()=>{socket.destroy();done(false);});socket.once('error',()=>done(false));});assert.equal(connected,false);
      await assert.rejects(()=>command({kind:'create',label:'forbidden',url:'http://127.0.0.1/'}),/LAB_FIXTURE_ONLY/);
    });
    const ids:string[]=[];
    await sample('idle',700);
    await check('manual-login-isolated-and-storage-types',async()=>{
      for(let index=0;index<4;index++){
        const id=await fixtureAccount(`Conta ${index+1}`);ids.push(id);await command({kind:'open',accountId:id});assert.equal((await inspect(id)).authenticated,false);
        // Assert the static login page is visible before input/animation can mask a capture bug.
        assert.ok((await until(()=>client.frame(id),frame=>!!frame?.jpeg))?.jpeg);
        await login(id,`demo-account-${index+1}`);
        const state=await inspect(id);assert.equal(state.user.username,`demo-account-${index+1}`);assert.equal(state.localStorageUser,state.user.username);assert.equal(state.sessionStorageUser,state.user.username);assert.equal(state.indexedDBUser,state.user.username);
        if([0,1,3].includes(index))await sample(`accounts-${index+1}`);
      }
    });
    await check('four-concurrent-cdp-streams',async()=>{
      const sequences:number[]=[];for(const id of ids){const frame=await until(()=>client.frame(id),frame=>!!frame?.jpeg);assert.ok(frame);assert.ok(Buffer.from(frame.jpeg,'base64').length>1000);sequences.push(frame.sequence);}
      await pause(800);for(let i=0;i<ids.length;i++)assert.ok((await client.frame(ids[i]!))!.sequence>sequences[i]!);
      const extra=await fixtureAccount('Canvas','http://canvas.test/');await assert.rejects(()=>command({kind:'open',accountId:extra}),/VISIBLE_LIMIT/);
    });
    await check('semantic-live-mirror-and-leader-failure',async()=>{
      await command({kind:'room',accountIds:ids,leaderId:ids[0]!,mirror:true});const result=await click(ids[0]!,'heal');assert.equal(result.results?.length,4);assert.ok(result.results?.every(r=>r.state==='succeeded'));assert.equal(result.recordedStep?.kind,'click');
      for(let index=0;index<8;index++){const start=performance.now();const mirrored=await click(ids[0]!,'heal');assert.ok(mirrored.results?.every(r=>r.state==='succeeded'));mirrorRoundTrips.push(performance.now()-start);}
      for(const id of ids)assert.equal((await inspect(id)).user.heals,9);
      const failed=await click(ids[0]!,'reject');assert.equal(failed.results?.[0]?.state,'failed');assert.equal(failed.results?.length,1);for(const id of ids)assert.equal((await inspect(id)).user.visits,0);
      await command({kind:'room',accountIds:ids,leaderId:ids[0]!,mirror:false});
    });
    const canvasId=(await client.status()).accounts.find(a=>a.url.includes('canvas.test'))!.id;
    await check('canvas-pointer-and-origin-boundary',async()=>{
      await command({kind:'close',accountId:ids[3]!});await command({kind:'open',accountId:canvasId});assert.equal((await inspect(canvasId)).authenticated,false);await login(canvasId,'demo-canvas');
      await click(canvasId,'load');await click(canvasId,'canvas');const state=await inspect(canvasId);assert.equal(state.user.canvasClicks,1);assert.ok(state.canvasFrame?.includes('Canvas pronto'));assert.equal(state.canvasPixel?.[3],255);
      await assert.rejects(()=>command({kind:'room',accountIds:[ids[0]!,canvasId],leaderId:ids[0]!,mirror:true}),/ROOM_SITE_MISMATCH/);await sample('canvas-heavy');
      await command({kind:'close',accountId:canvasId});await command({kind:'open',accountId:ids[3]!});
    });
    await check('shared-react-viewer-layouts-input-and-recording',async()=>{
      const page=await viewer();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      await page.getByTestId('account-panel').first().waitFor();
      for(const count of [1,2,3,4]){await page.getByTestId('layout').selectOption(String(count));await page.waitForFunction(n=>document.querySelectorAll('[data-testid="account-panel"]').length===n,count);}
      await until(async()=>page.locator('[data-testid^="frame-"]').count(),count=>count===4);
      const note='Olá, ação — 日本語 — ação composta';await uiClick(page,ids[0]!,'note');await page.getByTestId('remote-text').fill(note);await page.getByRole('button',{name:'Enviar texto',exact:true}).click();await pause(150);await uiClick(page,ids[0]!,'save-note');await until(()=>inspect(ids[0]!),value=>value.user.note===note);
      await page.getByLabel('Gravar receita').check();await uiClick(page,ids[0]!,'heal');await page.waitForFunction(()=>document.querySelectorAll('.lab-recipe li').length===1);
      await page.getByTestId('simulate').click();await page.getByTestId('plan-summary').waitFor();assert.match(await page.getByTestId('plan-summary').innerText(),/4 ações/);await page.getByTestId('confirm').click();await until(async()=>(await client.status()).batches.at(-1)!,value=>value.state==='completed',20000);
      await page.screenshot({path:'/artifacts/workbench.png',fullPage:true});assert.deepEqual(errors,[]);
      await uiBrowser!.close();uiBrowser=undefined;await new Promise<void>(done=>uiServer!.close(()=>done()));uiServer=undefined;
    });
    await closeAll();
    while(ids.length<10){const id=await fixtureAccount(`Conta ${ids.length+1}`);ids.push(id);await command({kind:'open',accountId:id});await login(id,`demo-account-${ids.length}`);await command({kind:'close',accountId:id});}
    const baseline=Object.fromEntries(await Promise.all(ids.map(async id=>[id,(await inspect(id)).user])));
    const recipe:LabStep[]=[{kind:'click',target:{by:'testId',value:'heal'}},{kind:'click',target:{by:'testId',value:'shop'}},{kind:'assert',target:{by:'testId',value:'result'},text:'OK: shop'}];
    await check('dry-run-is-side-effect-free-and-confirmation-is-unique',async()=>{
      const simulation=await command({kind:'simulate',accountIds:ids,steps:recipe,windowSeconds:1});assert.ok(simulation.plan);assert.equal(simulation.plan.actionCount,30);assert.equal((await client.status()).metrics.contexts,0);
      for(const id of ids)assert.deepEqual((await inspect(id)).user,baseline[id]);
      await assert.rejects(()=>command({kind:'confirm',planId:simulation.plan!.id,hash:'0'.repeat(64)}),/PLAN_INVALID/);
      const started=await command({kind:'confirm',planId:simulation.plan.id,hash:simulation.plan.hash});assert.ok(started.batchId);const duplicate=await command({kind:'confirm',planId:simulation.plan.id,hash:simulation.plan.hash});assert.equal(started.batchId,duplicate.batchId);
      const sampler=setInterval(()=>{void client.status().then(value=>samples.push({phase:'batch-10',at:Date.now(),metrics:value.metrics}));},250);
      try{const batch=await batchDone(started.batchId);assert.equal(batch.state,'completed');assert.equal(batch.completed,30);assert.equal(batch.results.length,30);assert.ok(batch.results.every(r=>r.state==='succeeded'));}finally{clearInterval(sampler);}
      for(const id of ids){const result=(await inspect(id)).user;assert.equal(result.heals,baseline[id]!.heals+1);assert.equal(result.visits,baseline[id]!.visits+1);}
      assert.ok(samples.filter(s=>s.phase==='batch-10').every(s=>s.metrics.contexts<=2));
    });
    await check('four-visible-plus-two-background',async()=>{
      for(const id of ids.slice(0,4))await command({kind:'open',accountId:id});
      const plan=(await command({kind:'simulate',accountIds:ids.slice(-2),steps:[recipe[0]!,{kind:'assert',target:{by:'testId',value:'result'},text:'OK: heal'}],windowSeconds:0})).plan!;
      const started=await command({kind:'confirm',planId:plan.id,hash:plan.hash});
      const timer=setInterval(()=>{void client.status().then(value=>samples.push({phase:'four-plus-two',at:Date.now(),metrics:value.metrics}));},50);
      try{assert.equal((await batchDone(started.batchId!)).state,'completed');}finally{clearInterval(timer);}
      assert.ok(samples.some(s=>s.phase==='four-plus-two'&&s.metrics.contexts===6));
    });
    await check('failed-step-blocks-successor-without-retry',async()=>{
      const before=(await inspect(ids[0]!)).user;const steps:LabStep[]=[recipe[0]!,{kind:'assert',target:{by:'testId',value:'result'},text:'impossible-condition'},recipe[1]!];
      const plan=(await command({kind:'simulate',accountIds:[ids[0]!],steps,windowSeconds:0})).plan!;const batch=await batchDone((await command({kind:'confirm',planId:plan.id,hash:plan.hash})).batchId!);
      assert.equal(batch.state,'partial');assert.equal(batch.results.length,2);assert.notEqual(batch.results[1]!.state,'succeeded');const after=(await inspect(ids[0]!)).user;assert.equal(after.heals,before.heals+1);assert.equal(after.visits,before.visits);
    });
    await check('cancel-and-stale-plan',async()=>{
      const plan=(await command({kind:'simulate',accountIds:[ids[1]!,ids[2]!],steps:recipe,windowSeconds:8})).plan!;const started=await command({kind:'confirm',planId:plan.id,hash:plan.hash});await command({kind:'cancel',batchId:started.batchId!});assert.equal((await batchDone(started.batchId!)).state,'cancelled');
      await command({kind:'open',accountId:ids[1]!});const stale=(await command({kind:'simulate',accountIds:[ids[1]!],steps:recipe,windowSeconds:0})).plan!;await command({kind:'step',accountId:ids[1]!,step:recipe[0]!,mirror:false});await assert.rejects(()=>command({kind:'confirm',planId:stale.id,hash:stale.hash}),/PLAN_EXPIRED/);await command({kind:'close',accountId:ids[1]!});
    });
    await closeAll();await sample('all-closed');assert.equal((await client.status()).metrics.contexts,0);
    const resumeIds=[...ids.slice(1,4),canvasId];
    await writeFile('/artifacts/prepare.json',JSON.stringify({cases,samples,resumeIds,blockedId:ids[0],mirrorRoundTrips,durationMs:Date.now()-began},null,2));
    console.log('PREPARE_COMPLETE');
  }else{
    const before=JSON.parse(await readFile('/artifacts/prepare.json','utf8')) as {cases:Case[];samples:typeof samples;resumeIds:string[];blockedId:string;durationMs:number;mirrorRoundTrips:number[]};
    await check('restore-after-container-process-restart',async()=>{
      assert.equal((await client.status()).metrics.contexts,0);await assert.rejects(()=>command({kind:'open',accountId:before.blockedId}),/PROFILE_BLOCKED/);
      for(const id of before.resumeIds){await command({kind:'open',accountId:id});const state=await inspect(id);assert.equal(state.authenticated,true);assert.equal(state.localStorageUser,state.user.username);assert.equal(state.sessionStorageUser,state.user.username);assert.equal(state.indexedDBUser,state.user.username);await until(()=>client.frame(id),frame=>!!frame?.jpeg);}
      await sample('restored-four');await closeAll();
    });
    const allSamples=[...before.samples,...samples];const latencies=[...(before.samples.at(-1)?.metrics.latencyMs??[])].sort((a,b)=>a-b);const roundTrips=[...before.mirrorRoundTrips].sort((a,b)=>a-b);
    const phaseMetrics=[...new Set(allSamples.map(s=>s.phase))].map(phase=>{
      const rows=allSamples.filter(s=>s.phase===phase),first=rows[0]!,last=rows.at(-1)!;
      const elapsed=Math.max(1,last.at-first.at);
      return {phase,samples:rows.length,observedMilliseconds:elapsed,peakMemoryMiB:Math.max(...rows.map(s=>s.metrics.memoryBytes))/1048576,meanCpuCores:Math.max(0,last.metrics.cpuMs-first.metrics.cpuMs)/elapsed,framesPerSecond:Math.max(0,last.metrics.frames-first.metrics.frames)*1000/elapsed,maxContexts:Math.max(...rows.map(s=>s.metrics.contexts))};
    });
    const report={schemaVersion:1,createdAt:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch,node:process.version,workerCpuQuota:2,workerMemoryLimitMiB:2048,viewer:'Chromium headless; same React component as Electron'},cases:[...before.cases,...cases],metrics:{maxContexts:Math.max(...allSamples.map(s=>s.metrics.contexts)),peakWorkerMemoryMiB:Math.max(...allSamples.map(s=>s.metrics.memoryBytes))/1048576,peakRssMiB:Math.max(...allSamples.map(s=>s.metrics.rssBytes))/1048576,mirrorDispatchP95Ms:latencies[Math.floor(latencies.length*.95)]??null,mirrorRoundTripP95Ms:roundTrips[Math.floor(roundTrips.length*.95)]??null,durationMs:before.durationMs+Date.now()-began},phaseMetrics,samples:allSamples,limitations:['Controlled HTTP fixtures only; no commercial proxy or arbitrary-site certification.','Renderer tested headlessly; native Electron/OS vault and Windows/macOS remain unverified.','Worker measurements exclude the separate verifier/UI container and gateway/fixture.','Short functional benchmark; no 100/300/500-account capacity or long-running soak claim.']};
    await writeFile('/artifacts/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({result:'passed',cases:report.cases.length,metrics:report.metrics}));
  }
}catch(error){await writeFile('/artifacts/failure.json',JSON.stringify({phase,cases,error:error instanceof Error?error.message:'VERIFICATION_FAILED'},null,2));console.error('PHASE0_VERIFICATION_FAILED',error instanceof Error?error.message:'unknown');process.exitCode=1;}
finally{await uiBrowser?.close();if(uiServer)await new Promise<void>(done=>uiServer!.close(()=>done()));}
