import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';

const phase=['phase2','phase3'].includes(process.argv[2])?process.argv[2]:'phase1';
const project=`msm-${phase}-check-${randomBytes(4).toString('hex')}`;
const runtime=resolve(`.runtime/checks/${project}`);
const artifacts=resolve(`.runtime/artifacts/${project}`);
await mkdir(artifacts,{recursive:true,mode:0o700});
const env={...process.env,MSM_RUNTIME_DIR:runtime,MSM_LAB_CONTROL_VOLUME:`${project}_control`,MSM_VERIFY_ARTIFACT_DIR:artifacts,MSM_VERIFY_WORKSPACE:phase!=='phase1'?'1':'0',MSM_VERIFY_ENGINE:phase==='phase3'?'1':'0',MSM_MAX_ACCOUNTS:'500'};
const compose=['compose','-p',project,'-f','infra/compose/compose.yaml','-f','infra/compose/phase1.verify.yaml','--profile','isolation'];
if(process.platform==='linux'){
  env.MSM_ELECTRON_DIST=resolve('node_modules/electron/dist');
  compose.splice(compose.length-2,0,'-f','infra/compose/phase1.linux-verify.yaml');
}
const steps=[];
let active,interrupted=false;
const stop=()=>{interrupted=true;active?.kill('SIGTERM');};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
async function run(label,command,args,extraEnv={}) {
  const start=Date.now();let output='';
  const code=await new Promise((done,reject)=>{
    active=spawn(command,args,{env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
    for(const stream of [active.stdout,active.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-2_000_000);});
    active.once('error',reject);active.once('exit',value=>done(value??1));
  });
  active=undefined;
  await writeFile(`${artifacts}/${label}.log`,output,{mode:0o600});
  if(code!==0)throw Error(`${label} failed (${code}):\n${output.slice(-6000)}`);
  steps.push({name:label,passed:true,durationMs:Date.now()-start});console.log(`PASS ${label}`);
  return output;
}
const docker=(label,args)=>run(label,'docker',[...compose,...args]);
async function snapshot(path){
  const entries=await readdir(path,{withFileTypes:true});const values={};
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.name==='artifacts')continue;
    const file=`${path}/${entry.name}`;
    if(entry.isDirectory())Object.assign(values,Object.fromEntries(Object.entries(await snapshot(file)).map(([name,hash])=>[`${entry.name}/${name}`,hash])));
    else values[entry.name]=createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return values;
}
let passed=false,failure;
try {
  await run('bootstrap',process.execPath,['--import','tsx','scripts/bootstrap.ts']);
  const before=await snapshot(runtime);
  await run('bootstrap-repeat',process.execPath,['--import','tsx','scripts/bootstrap.ts']);
  assert.deepEqual(await snapshot(runtime),before,'Bootstrap must preserve installation secrets and identity');
  await run('preflight',process.execPath,['--import','tsx','scripts/preflight.ts']);
  await run('unit',process.execPath,['scripts/test.mjs','unit']);
  if(process.platform==='linux')await run('electron-binary',process.execPath,['scripts/install-electron.mjs']);
  await docker('compose-config',['config','--quiet']);
  await docker('build-typecheck',['build','--quiet','api','runner','desktop-check']);
  await docker('start',['up','-d','--no-build','--wait','api','gateway']);
  // Replaying migration must preserve checksums and tenant data.
  await docker('migration-repeat',['run','--no-deps','--rm','migrate']);
  await docker('integration',['run','--no-deps','--rm','integration']);
  await docker('runner',['run','--no-deps','--rm','runner']);
  await docker('desktop-prepare',['run','--no-deps','--rm','-e','MSM_VERIFY_STAGE=prepare','desktop-check']);
  await docker('api-restart',['restart','api']);
  await docker('api-ready',['up','-d','--no-build','--wait','api']);
  await docker('desktop-restore',['run','--no-deps','--rm','-e','MSM_VERIFY_STAGE=restore','desktop-check']);
  const reports=await Promise.all(['integration','desktop-prepare','desktop-restore',...(phase!=='phase1'?['workspace']:[]),...(phase==='phase3'?['engine']:[])].map(async name=>JSON.parse(await readFile(`${artifacts}/${name}.json`,'utf8'))));
  assert.ok(reports.every(report=>report.passed));
  passed=true;
} catch(error) {
  failure=error instanceof Error?error.message:'PHASE1_CHECK_FAILED';
  console.error(failure);process.exitCode=1;
  await docker('failure-service-logs',['logs','--no-color','--tail','40','api','migrate','gateway']).catch(()=>{});
} finally {
  try {await docker('cleanup',['down','--volumes','--remove-orphans']);await rm(runtime,{recursive:true,force:true});}
  catch(error){passed=false;process.exitCode=1;failure??=error instanceof Error?error.message:'CLEANUP_FAILED';}
  for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,stop);
  const report={schemaVersion:1,phase,passed:passed&&!interrupted,createdAt:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch,node:process.version},project,artifactDirectory:artifacts,steps,...(failure?{failure}:{}),scope:{realPostgres:true,realRedis:true,mutualTls:true,chromiumSandbox:true,electronXvfb:true,apiProcessRestart:true,isolatedVolumes:true,hostPortsPublished:false,workspaceUi:phase!=='phase1',durableEngine:phase==='phase3'},limitations:['Validated on this Linux server only; Windows/macOS native vaults and installers need platform certification.',phase==='phase3'?'Durable campaigns execute registry/proxy diagnostics. Browser adapters, live session ownership and licensing belong to subsequent phases.':'Production browser automation and licensing belong to subsequent phases.']};
  await writeFile(`${artifacts}/report.json`,JSON.stringify(report,null,2),{mode:0o600});
  // Always publish the latest outcome; a failed run must not leave a stale green result.
  await writeFile(`.runtime/artifacts/${phase}-latest.json`,JSON.stringify(report,null,2),{mode:0o600});
  console.log(`Relatório: ${artifacts}/report.json`);
}
