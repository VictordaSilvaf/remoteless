import {spawn} from 'node:child_process';
const run=args=>new Promise((done,reject)=>{const child=spawn('docker',args,{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error(`Docker command failed (${code})`)));});
await new Promise((done,reject)=>{const child=spawn(process.execPath,['--import','tsx','scripts/preflight.ts'],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error('A configuração local não passou na verificação. Execute npm run setup e npm run doctor.')));});
await run(['volume','create','msm-phase0_control']);
await run(['compose','-p','msm-phase1','-f','infra/compose/compose.yaml','up','-d','--build','--wait']);
