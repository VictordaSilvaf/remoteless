import assert from 'node:assert/strict';
import {createServer,createConnection,type Socket} from 'node:net';
import {writeFile} from 'node:fs/promises';
import {chromium,type Browser,type Page} from 'playwright';
import {spawn,type ChildProcess} from 'node:child_process';
import {LocalClient} from '../../desktop/src/main/client.js';
const connections=new Set<Socket>();
const bridge=createServer(client=>{connections.add(client);const upstream=createConnection({host:'api',port:8443});upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.pipe(upstream).pipe(client);client.on('close',()=>{upstream.destroy();connections.delete(client);});});
await new Promise<void>(done=>bridge.listen(17643,'127.0.0.1',done));
const client=new LocalClient('/run/msm-runtime/client');
let electron:Browser|undefined,processHandle:ChildProcess|undefined;
let page:Page|undefined,diagnostics='';
const owned:string[]=[];
try{
  await client.initialize();await client.connect();let status=await client.labStatus();
  const firstOrigin=status.accounts.find(account=>account.url.startsWith('http://fixture.test/'))?.url??'http://fixture.test/';
  while(status.accounts.filter(account=>account.url===firstOrigin).length<4){await client.labCommand({kind:'create',label:`Electron ${status.accounts.length+1}`,url:firstOrigin});status=await client.labStatus();}
  const ids=status.accounts.filter(account=>account.url===firstOrigin).slice(0,4).map(account=>account.id);
  for(const account of status.accounts)if(account.state==='visible'&&!ids.includes(account.id))await client.labCommand({kind:'close',accountId:account.id});
  for(const id of ids){await client.labCommand({kind:'open',accountId:id});owned.push(id);}
  processHandle=spawn('/opt/electron/electron',['--enable-sandbox','--remote-debugging-port=9228','/app/apps/desktop/dist/main.js'],{stdio:['ignore','ignore','pipe'],env:{...process.env,MSM_RUNTIME_DIR:'/run/msm-runtime',MSM_DESKTOP_DATA_DIR:'/tmp/msm-electron-userdata'}});
  processHandle.stderr?.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-6000);});
  processHandle.on('error',()=>{});
  const deadline=Date.now()+30000;let ready=false;
  while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:9228/json/version');if(response.ok){ready=true;break;}}catch{}if(processHandle.exitCode!==null)throw Error(`ELECTRON_EXITED: ${diagnostics}`);await new Promise(done=>setTimeout(done,150));}
  if(!ready)throw Error(`ELECTRON_START_TIMEOUT: ${diagnostics}`);
  electron=await chromium.connectOverCDP('http://127.0.0.1:9228',{timeout:15000});
  const context=electron.contexts()[0]!;page=context.pages()[0]??await context.waitForEvent('page',{timeout:15000});
  await page.getByRole('button',{name:'Conectar instalação',exact:true}).click();await page.getByText('Pareado',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Abrir laboratório',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-testid="account-panel"]').length===4);
  await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="frame-"]').length===4);
  for(const id of ids)assert.ok((await client.labFrame(id))?.jpeg);
  const isolation=await page.evaluate(()=>({node:typeof (window as unknown as {require?:unknown}).require,bridge:typeof window.multisession.lab.command}));
  assert.deepEqual(isolation,{node:'undefined',bridge:'function'});
  const hardened=await page.evaluate(()=>window.multisession.security);
  assert.deepEqual(hardened,{sandboxed:true,contextIsolated:true});
  await page.screenshot({path:'/artifacts/electron-workbench.png',fullPage:true});
  await writeFile('/artifacts/electron-report.json',JSON.stringify({passed:true,platform:process.platform,arch:process.arch,viewer:'Electron real with Xvfb',panels:4,tls:'mutual',ipc:'main/preload/renderer',preferences:hardened,rendererIsolation:isolation,limitations:['Linux arm64 only; native OS vault and physical IME are not exercised.']},null,2));
  console.log('PASS actual-electron-main-preload-renderer-four-panels');
}catch(error){
  await page?.screenshot({path:'/artifacts/electron-failure.png',fullPage:true}).catch(()=>{});
  await writeFile('/artifacts/electron-failure.json',JSON.stringify({passed:false,error:error instanceof Error?error.message:'ELECTRON_CHECK_FAILED',diagnostics},null,2));
  throw error;
}finally{await electron?.close();processHandle?.kill('SIGTERM');for(const id of owned)await client.labCommand({kind:'close',accountId:id}).catch(()=>{});client.dispose();for(const connection of connections)connection.destroy();await new Promise<void>(done=>bridge.close(()=>done()));}
