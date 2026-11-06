import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkInstallation} from '../../scripts/support/installation.js';
import {withTenant,type Pool} from '@msm/database';

test('bootstrap preserves secrets and doctor rejects insecure files and incorrect certificate pins',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'msm-bootstrap-'));
  const run=()=>promisify(execFile)(process.execPath,['--import','tsx','scripts/bootstrap.ts'],{env:{...process.env,MSM_RUNTIME_DIR:directory}});
  try {
    const first=await run();
    const files=['client/connection.json','client/desktop.key','server/installation.json','authority/ca.key','secrets/app_password','lab/root-key'];
    const before=await Promise.all(files.map(file=>readFile(`${directory}/${file}`,'utf8')));
    await run();
    assert.deepEqual(await Promise.all(files.map(file=>readFile(`${directory}/${file}`,'utf8'))),before);
    assert.equal(first.stdout.includes(before[4]!),false);
    assert.equal((await checkInstallation(directory)).passed,true);
    if(process.platform!=='win32') {
      await chmod(`${directory}/client/desktop.key`,0o644);
      await assert.rejects(()=>checkInstallation(directory),/INSECURE_RUNTIME_PERMISSIONS/);
      await chmod(`${directory}/client/desktop.key`,0o600);
    }
    const installation=JSON.parse(before[2]!);installation.clientFingerprint='incorrect-pin';
    await writeFile(`${directory}/server/installation.json`,JSON.stringify(installation),{mode:0o600});
    await assert.rejects(()=>checkInstallation(directory),/CLIENT_CERTIFICATE_PIN_MISMATCH/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('failed tenant cleanup discards the connection and preserves the original error',async()=>{
  const original=new Error('work failed');let released:Error|undefined;
  const connection={query:async(sql:string)=>{if(sql==='ROLLBACK')throw Error('connection lost');return {rows:[]};},release:(error?:Error)=>{released=error;}};
  const pool={connect:async()=>connection} as unknown as InstanceType<typeof Pool>;
  await assert.rejects(()=>withTenant(pool,'00000000-0000-4000-8000-000000000001',async()=>{throw original;}),error=>error===original);
  assert.ok(released instanceof Error);
});
