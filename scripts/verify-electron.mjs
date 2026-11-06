import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

const env={...process.env};
const run=(command,args)=>new Promise((done,reject)=>{
  const child=spawn(command,args,{env,stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error(`Electron verification failed (${code})`)));
});
const args=['compose','-p','msm-phase0-electron','-f','infra/compose/phase0.electron.yaml'];
if(process.platform==='linux'){
  await run(process.execPath,['scripts/install-electron.mjs']);
  env.MSM_ELECTRON_DIST=resolve('node_modules/electron/dist');
  args.push('-f','infra/compose/phase0.electron.linux.yaml');
}
await run('docker',[...args,'run','--build','--rm','desktop-check']);
