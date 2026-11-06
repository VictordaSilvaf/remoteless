import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {chromium,type Browser,type Page} from 'playwright';
import {LocalClient} from '../apps/desktop/src/main/client.js';
import {installationBridge} from './support/tls-bridge.js';
import {verifyWorkspace} from './support/workspace-desktop.js';

const stage=process.env.MSM_VERIFY_STAGE??'prepare';
if(!['prepare','restore'].includes(stage))throw Error('INVALID_VERIFICATION_STAGE');
const passphrase='phase1-only-test-passphrase';
const keyFile='/state/desktop/vault/root-key.json';
const closeBridge=await installationBridge();
const client=new LocalClient('/run/msm-runtime/client');
let processHandle:ChildProcess|undefined,browser:Browser|undefined,page:Page|undefined,diagnostics='';
const cases:string[]=[];
try {
  await client.initialize();await client.connect();
  assert.equal((await client.status()).vault,'locked','API must start with a locked vault');
  processHandle=spawn('/opt/electron/electron',['--enable-sandbox','--password-store=basic','--remote-debugging-port=9228','/app/apps/desktop/dist/main.js'],{stdio:['ignore','ignore','pipe'],env:{...process.env,MSM_RUNTIME_DIR:'/run/msm-runtime',MSM_DESKTOP_DATA_DIR:'/state/desktop'}});
  processHandle.stderr?.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-6000);});
  let spawnError:Error|undefined;processHandle.once('error',error=>{spawnError=error;});
  const deadline=Date.now()+30000;let ready=false;
  while(Date.now()<deadline){
    if(spawnError)throw spawnError;
    if(processHandle.exitCode!==null)throw Error(`ELECTRON_EXITED: ${diagnostics}`);
    try{if((await fetch('http://127.0.0.1:9228/json/version')).ok){ready=true;break;}}catch{}
    await new Promise(done=>setTimeout(done,150));
  }
  if(!ready)throw Error(`ELECTRON_START_TIMEOUT: ${diagnostics}`);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9228',{timeout:15000});
  const context=browser.contexts()[0]!;
  page=context.pages()[0]??await context.waitForEvent('page',{timeout:15000});
  await page.getByRole('button',{name:'Conectar instalação',exact:true}).click();
  await page.getByText('Pareado',{exact:true}).waitFor();
  const security=await page.evaluate(()=>({flags:window.multisession.security,require:typeof (window as unknown as {require?:unknown}).require,process:typeof (window as unknown as {process?:unknown}).process,methods:Object.keys(window.multisession).sort()}));
  assert.deepEqual(security.flags,{sandboxed:true,contextIsolated:true});
  assert.equal(security.require,'undefined');assert.equal(security.process,'undefined');
  assert.deepEqual(security.methods,['connect','lab','lockVault','security','status','unlockVault','workspace']);
  cases.push('real-electron-mutual-tls-and-restricted-preload');
  await page.getByRole('button',{name:'Desbloquear cofre',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Informe uma senha'}).waitFor();
  assert.equal((await client.status()).vault,'locked');
  cases.push('basic-text-backend-requires-passphrase');

  if(stage==='restore') {
    await page.getByLabel('Senha do cofre').fill('wrong-phase1-test-passphrase');
    await page.getByRole('button',{name:'Desbloquear cofre',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'A senha do cofre não confere'}).waitFor();
    assert.equal((await client.status()).vault,'locked');
    cases.push('wrong-passphrase-does-not-unlock');
    const original=await readFile(keyFile,'utf8');
    const corrupted=JSON.parse(original);const data=corrupted.envelope.ciphertext as string;
    corrupted.envelope.ciphertext=(data[0]==='A'?'B':'A')+data.slice(1);
    await writeFile(keyFile,JSON.stringify(corrupted),{mode:0o600});
    try {
      await page.getByLabel('Senha do cofre').fill(passphrase);
      await page.getByRole('button',{name:'Desbloquear cofre',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'A senha do cofre não confere'}).waitFor();
      assert.equal((await client.status()).vault,'locked');
    } finally {await writeFile(keyFile,original,{mode:0o600});}
    cases.push('tampered-device-key-fails-closed');
  }
  await page.getByLabel('Senha do cofre').fill(passphrase);
  await page.getByRole('button',{name:'Desbloquear cofre',exact:true}).click();
  await page.getByRole('button',{name:'Bloquear cofre',exact:true}).waitFor();
  assert.equal((await client.status()).vault,'healthy');
  const saved=await readFile(keyFile,'utf8');
  assert.equal(JSON.parse(saved).kind,'passphrase');assert.equal(saved.includes(passphrase),false);
  assert.equal((await stat(keyFile)).mode&0o077,0);
  cases.push(stage==='prepare'?'encrypted-key-enrolment-through-ui':'same-key-restored-after-api-and-desktop-restart');
  if(stage==='restore'&&process.env.MSM_VERIFY_WORKSPACE==='1')await verifyWorkspace(page,client);
  await page.screenshot({path:`/artifacts/desktop-${stage}.png`,fullPage:true});
  if(stage==='restore') {
    await page.getByRole('button',{name:'Bloquear cofre',exact:true}).click();
    await page.getByRole('button',{name:'Desbloquear cofre',exact:true}).waitFor();
    assert.equal((await client.status()).vault,'locked');
    cases.push('manual-vault-lock');
  }
  await writeFile(`/artifacts/desktop-${stage}.json`,JSON.stringify({passed:true,stage,platform:process.platform,arch:process.arch,cases,security,provider:'passphrase/Argon2id; Linux basic_text deliberately refused',limitations:['Native Windows/macOS key providers are outside this Linux verification.']},null,2));
  for(const name of cases)console.log(`PASS ${name}`);
} catch(error) {
  await page?.screenshot({path:`/artifacts/desktop-${stage}-failure.png`,fullPage:true}).catch(()=>{});
  await writeFile(`/artifacts/desktop-${stage}.json`,JSON.stringify({passed:false,stage,cases,error:error instanceof Error?error.message:'DESKTOP_CHECK_FAILED',diagnostics},null,2));
  throw error;
} finally {
  await browser?.close().catch(()=>{});processHandle?.kill('SIGTERM');client.dispose();await closeBridge();
}
