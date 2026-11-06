import {createServer} from 'node:http';
import {createServer as createTcpServer,createConnection} from 'node:net';
import {readFile,unlink,chmod,writeFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {ZodError} from 'zod';
import {uuidSchema} from '@msm/contracts';
import {LabEngine,LabError,type LabConfig} from './engine.js';

if(process.getuid?.()===0)throw Error('ROOT_RUNNER_FORBIDDEN');
const config=JSON.parse(await readFile('/run/lab/config.json','utf8')) as LabConfig;
uuidSchema.parse(config.tenantId);uuidSchema.parse(config.groupId);
const engine=new LabEngine(config,'/state');await engine.initialize((await readFile('/run/lab/root-key','utf8')).trim());
const bridge=createTcpServer(client=>{const upstream=createConnection('/proxy/egress.sock');upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.pipe(upstream).pipe(client);client.on('close',()=>upstream.destroy());});
await new Promise<void>(resolve=>bridge.listen(3138,'127.0.0.1',resolve));
const socket='/run/msm/lab/control.sock';await unlink(socket).catch(error=>{if(error.code!=='ENOENT')throw error;});
const server=createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const token=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${config.capability}`);
  if(token.length!==expected.length||!timingSafeEqual(token,expected)){send(403,{error:'LAB_CAPABILITY_REQUIRED'});return;}
  try{
    if(req.method==='GET'&&req.url==='/status'){send(200,await engine.status());return;}
    if(req.method==='GET'&&req.url?.startsWith('/frame/')){send(200,engine.frame(uuidSchema.parse(req.url.slice(7))));return;}
    if(req.method==='POST'&&req.url==='/command'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw new LabError('PAYLOAD_TOO_LARGE',413);}send(200,await engine.command(JSON.parse(body)));return;
    }
    if(process.env.MSM_LAB_DIAGNOSTICS==='1'&&req.method==='GET'&&req.url?.startsWith('/inspect/')){send(200,await engine.inspect(uuidSchema.parse(req.url.slice(9))));return;}
    if(process.env.MSM_LAB_DIAGNOSTICS==='1'&&req.method==='POST'&&req.url==='/bounds'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)throw new LabError('PAYLOAD_TOO_LARGE',413);}const input=JSON.parse(body);send(200,await engine.bounds(uuidSchema.parse(input.accountId),String(input.testId)));return;
    }
    send(404,{error:'NOT_FOUND'});
  }catch(error){send(error instanceof LabError?error.status:error instanceof ZodError||error instanceof SyntaxError?400:500,{error:error instanceof LabError?error.code:error instanceof ZodError?'INVALID_COMMAND':'LAB_OPERATION_FAILED'});}
});
server.requestTimeout=10000;server.maxConnections=64;
await new Promise<void>(resolve=>server.listen(socket,async()=>{await chmod(socket,0o600);await writeFile('/tmp/lab-ready','ready');resolve();}));
let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;void(async()=>{await engine.shutdown();server.close();bridge.close();})().catch(()=>process.exit(1));});
console.log(JSON.stringify({component:'session-lab',state:'ready',protocolVersion:1}));
