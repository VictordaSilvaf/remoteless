import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
const mode=process.argv[2]??'up';
function run(args,env=process.env){return new Promise((done,reject)=>{const child=spawn('docker',args,{stdio:'inherit',env});child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error(`Docker command failed (${code})`)));});}
if(mode==='verify'){
  const project=`msm-phase0-check-${randomBytes(3).toString('hex')}`;
  const artifacts=resolve(`.runtime/artifacts/${project}`);await mkdir(artifacts,{recursive:true,mode:0o700});
  const env={...process.env,MSM_LAB_CONTROL_VOLUME:`${project}_control`,MSM_LAB_ARTIFACT_DIR:artifacts};
  const args=['compose','-p',project,'-f','infra/compose/phase0.yaml','-f','infra/compose/phase0.verify.yaml','--profile','verify'];
  try{
    await run([...args,'build','--quiet','lab'],env);
    await run([...args,'up','-d','--no-build','--wait','lab'],env);
    await run([...args,'run','--no-deps','--rm','-e','MSM_VERIFY_STAGE=prepare','verify'],env);
    await run([...args,'restart','lab'],env);
    await run([...args,'up','-d','--wait','lab'],env);
    await run([...args,'run','--no-deps','--rm','-e','MSM_VERIFY_STAGE=finish','verify'],env);
    const report=JSON.parse(await readFile(`${artifacts}/report.json`,'utf8'));
    await writeFile('.runtime/artifacts/phase0-latest.json',JSON.stringify({...report,artifactDirectory:artifacts},null,2),{mode:0o600});
    console.log(`Relatório: ${artifacts}/report.json`);console.log(`Imagem: ${artifacts}/workbench.png`);
  }catch(error){await run([...args,'logs','--no-color','--tail','60','lab','gateway'],env).catch(()=>{});throw error;}
  finally{await run([...args,'down','--volumes'],env);}
}else{
  const args=['compose','-p','msm-phase0','-f','infra/compose/phase0.yaml'];
  if(mode==='up'){await mkdir('.runtime/artifacts/phase0',{recursive:true,mode:0o700});await run(['volume','create','msm-phase0_control']);await run([...args,'build','--quiet','lab']);await run([...args,'up','-d','--no-build','--wait','lab']);}
  else if(mode==='down')await run([...args,'down']);
  else if(mode==='status')await run([...args,'ps']);
  else throw Error('Unknown phase0 operation');
}
