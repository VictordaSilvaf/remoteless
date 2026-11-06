import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {installationBridge} from './support/tls-bridge.js';

const close=await installationBridge();
try {
  const code=await new Promise<number>((done,reject)=>{
    const child=spawn(process.execPath,['--test','--test-timeout=90000','scripts/dist/foundation-integration.test.js','scripts/dist/workspace-integration.test.js','scripts/dist/engine-integration.test.js'],{stdio:'inherit',env:process.env});
    child.once('error',reject);child.once('exit',value=>done(value??1));
  });
  await writeFile('/artifacts/integration.json',JSON.stringify({passed:code===0,realPostgres:true,realTls:true,hostPortsPublished:false},null,2));
  process.exitCode=code;
} finally {await close();}
