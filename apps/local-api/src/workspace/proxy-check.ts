import {connect as connectNet,isIP,type Socket} from 'node:net';
import {connect as connectTls,checkServerIdentity} from 'node:tls';
import {once} from 'node:events';
import {request,Agent} from 'node:http';
import {performance} from 'node:perf_hooks';
import {resolvePublic,destinationHost,type NetworkPolicy} from './network.js';
import {WorkspaceError} from './errors.js';

export interface ProxyEndpoint {scheme:'http'|'https'|'socks5';host:string;port:number;username?:string;password?:string;}
async function bytes(socket:Socket,count:number,signal:AbortSignal):Promise<Buffer>{
  for(;;){signal.throwIfAborted();const data=socket.read(count) as Buffer|null;if(data)return data;if(socket.destroyed||socket.readableEnded)throw new WorkspaceError('PROXY_CONNECTION_CLOSED');await once(socket,'readable',{signal});}
}
async function header(socket:Socket,signal:AbortSignal){let result='';while(result.length<16384){result+=(await bytes(socket,1,signal)).toString('latin1');if(result.endsWith('\r\n\r\n'))return result;}throw new WorkspaceError('PROXY_HEADERS_TOO_LARGE');}
async function encrypted(socket:Socket,host:string,ca:Buffer|undefined,signal:AbortSignal){
  const secure=connectTls({socket,host,servername:isIP(host)?undefined:host,rejectUnauthorized:true,...(ca?{ca}:{}),checkServerIdentity:(_name,certificate)=>checkServerIdentity(host,certificate)});
  secure.on('error',()=>{});await once(secure,'secureConnect',{signal});return secure;
}
async function socks(socket:Socket,target:URL,auth:ProxyEndpoint,signal:AbortSignal){
  socket.write(Buffer.from([5,1,auth.username?2:0]));
  const hello=await bytes(socket,2,signal);
  if(hello[0]!==5||hello[1]===255)throw new WorkspaceError('PROXY_AUTH_REQUIRED');
  if(hello[1]===2){
    if(!auth.username)throw new WorkspaceError('PROXY_AUTH_REQUIRED');
    const user=Buffer.from(auth.username),password=Buffer.from(auth.password??'');
    socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([password.length]),password]));
    const response=await bytes(socket,2,signal);if(response[0]!==1||response[1]!==0)throw new WorkspaceError('PROXY_AUTH_REJECTED');
  }else if(hello[1]!==0||auth.username)throw new WorkspaceError('PROXY_AUTH_REJECTED');
  // SOCKS5 resolves the configured probe hostname at the proxy, rather than leaking DNS through a direct target connection.
  const hostname=target.hostname.replace(/^\[|\]$/g,'');const host=Buffer.from(hostname);
  if(host.length>255)throw new WorkspaceError('PROXY_TARGET_INVALID');
  const port=Number(target.port||(target.protocol==='https:'?443:80)),encodedPort=Buffer.alloc(2);encodedPort.writeUInt16BE(port);
  let destination:Buffer;
  if(isIP(hostname)===4)destination=Buffer.from([1,...hostname.split('.').map(Number)]);
  else if(isIP(hostname)===6){const [left,right='']=hostname.split('::');const first=left?left.split(':'):[],last=right?right.split(':'):[];const groups=hostname.includes('::')?[...first,...Array(8-first.length-last.length).fill('0'),...last]:first;const ip=Buffer.alloc(16);groups.forEach((part,index)=>ip.writeUInt16BE(parseInt(part,16),index*2));destination=Buffer.concat([Buffer.from([4]),ip]);}
  else destination=Buffer.concat([Buffer.from([3,host.length]),host]);
  socket.write(Buffer.concat([Buffer.from([5,1,0]),destination,encodedPort]));
  const reply=await bytes(socket,4,signal);if(reply[0]!==5||reply[1]!==0)throw new WorkspaceError('PROXY_CONNECT_FAILED');
  const length=reply[3]===1?4:reply[3]===4?16:reply[3]===3?(await bytes(socket,1,signal))[0]!:0;
  if(!length)throw new WorkspaceError('PROXY_PROTOCOL_INVALID');await bytes(socket,length+2,signal);
}
export async function checkProxy(endpoint:ProxyEndpoint,probeRaw:string,policy:NetworkPolicy={}){
  const began=performance.now(),signal=AbortSignal.timeout(8000);let socket:Socket|undefined,agent:Agent|undefined;
  const abort=()=>socket?.destroy();signal.addEventListener('abort',abort,{once:true});
  try {
    if([endpoint.username,endpoint.password].some(value=>value&&Buffer.byteLength(value)>255))throw new WorkspaceError('PROXY_AUTH_TOO_LONG');
    const target=new URL(probeRaw);
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password||(target.protocol==='http:'&&!policy.allowPrivate))throw new WorkspaceError('PROXY_PROBE_INVALID');
    // The probe is installation-controlled, never supplied in a client command.
    // Send its hostname through the proxy without a local target DNS lookup.
    destinationHost(target.hostname,policy);
    const {host,addresses}=await resolvePublic(endpoint.host,policy);
    const address=addresses[0]!;
    socket=connectNet({host:address.address,port:endpoint.port,family:address.family});socket.on('error',()=>{});
    await once(socket,'connect',{signal});
    if(endpoint.scheme==='https')socket=await encrypted(socket,host,policy.proxyCa,signal);
    if(endpoint.scheme==='socks5')await socks(socket,target,endpoint,signal);
    else {
      const destination=`${target.hostname}:${target.port||(target.protocol==='https:'?'443':'80')}`;
      const auth=endpoint.username?`Proxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password??''}`).toString('base64')}\r\n`:'';
      socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n${auth}\r\n`);
      const response=await header(socket,signal);const status=Number(response.split(' ')[1]);
      if(status===407)throw new WorkspaceError('PROXY_AUTH_REJECTED');if(status!==200)throw new WorkspaceError('PROXY_CONNECT_FAILED');
    }
    if(target.protocol==='https:')socket=await encrypted(socket,target.hostname.replace(/^\[|\]$/g,''),policy.probeCa,signal);
    const transport=socket;
    agent=new Agent({keepAlive:false});agent.createConnection=(_options,callback)=>{callback?.(null,transport);return transport;};
    const ip=await new Promise<string>((done,reject)=>{
      const req=request({hostname:target.hostname,port:Number(target.port||(target.protocol==='https:'?443:80)),method:'GET',path:target.pathname+target.search,agent,signal,headers:{host:target.host,accept:'application/json',connection:'close'}},response=>{
        let body='';response.on('data',(chunk:Buffer)=>{body+=chunk.toString();if(body.length>4096){response.destroy();reject(new WorkspaceError('PROXY_PROBE_INVALID'));}});
        response.on('error',reject);response.on('end',()=>{try{const data=JSON.parse(body) as {ip?:unknown};if(response.statusCode!==200||typeof data.ip!=='string'||!isIP(data.ip))throw Error();done(data.ip);}catch{reject(new WorkspaceError('PROXY_PROBE_INVALID'));}});
      });req.on('error',reject);req.end();
    });
    return {state:'HEALTHY' as const,egressIp:ip,latencyMs:Math.round(performance.now()-began),errorCode:null};
  }catch(error){return {state:'UNAVAILABLE' as const,egressIp:null,latencyMs:Math.round(performance.now()-began),errorCode:error instanceof WorkspaceError?error.code:signal.aborted?'PROXY_TIMEOUT':'PROXY_CONNECTION_FAILED'};}
  finally{signal.removeEventListener('abort',abort);socket?.destroy();agent?.destroy();}
}
