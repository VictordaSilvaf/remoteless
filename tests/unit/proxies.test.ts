import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer,type Server as HttpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {createServer as netServer,connect,type Socket,type Server} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkProxy} from '../../apps/local-api/src/workspace/proxy-check.js';

test('real HTTP/HTTPS CONNECT and SOCKS5 probes preserve auth, remote DNS, IPv6 and fail closed',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'msm-proxy-protocols-'));
  const servers:Server[]=[],sockets=new Set<Socket>();let probeRequests=0;
  const hosts:string[]=[];
  async function listen(server:Server,host='127.0.0.1'){
    servers.push(server);server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
    await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,host,done);});
    return (server.address() as {port:number}).port;
  }
  function tunnel(server:HttpServer,port:number,auth:boolean){server.on('connect',(req,socket,head)=>{
    if(auth&&req.headers['proxy-authorization']!==`Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');return;}
    if(req.url!==`probe.test:${port}`&&req.url!==`localhost:${port}`){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const upstream=connect({host:'127.0.0.1',port});sockets.add(upstream);upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
    upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});socket.once('close',()=>upstream.destroy());
  });}
  async function take(socket:Socket,length:number){const signal=AbortSignal.timeout(10000);for(;;){const data=socket.read(length) as Buffer|null;if(data)return data;if(socket.destroyed)throw Error('closed');await once(socket,'readable',{signal});}}
  function socks(port:number,auth:boolean){return netServer(socket=>{void(async()=>{
    const greeting=await take(socket,2),methods=await take(socket,greeting[1]!);assert.equal(greeting[0],5);
    const method=auth?2:0;if(!methods.includes(method)){socket.end(Buffer.from([5,255]));return;}socket.write(Buffer.from([5,method]));
    if(auth){const header=await take(socket,2),user=(await take(socket,header[1]!)).toString(),passwordLength=(await take(socket,1))[0]!,password=(await take(socket,passwordLength)).toString();if(user!=='proxy-user'||password!=='proxy-password'){socket.end(Buffer.from([1,1]));return;}socket.write(Buffer.from([1,0]));}
    const request=await take(socket,4);assert.equal(request[0],5);
    if(request[3]===3){const length=(await take(socket,1))[0]!;hosts.push((await take(socket,length)).toString());}else await take(socket,request[3]===4?16:4);
    assert.equal((await take(socket,2)).readUInt16BE(),port);
    const upstream=connect({host:'127.0.0.1',port});sockets.add(upstream);upstream.on('error',()=>socket.destroy());
    upstream.once('connect',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));socket.pipe(upstream).pipe(socket);});socket.once('close',()=>upstream.destroy());
  })().catch(()=>socket.destroy());});}
  try {
    await promisify(execFile)(process.execPath,['--import','tsx','scripts/bootstrap.ts'],{env:{...process.env,MSM_RUNTIME_DIR:directory}});
    const ca=await readFile(`${directory}/authority/ca.crt`),key=await readFile(`${directory}/server/server.key`),cert=await readFile(`${directory}/server/server.crt`);
    const probe=httpServer((_req,res)=>{probeRequests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ip:'203.0.113.19'}));});const probePort=await listen(probe);
    const dnsQueries:string[]=[];
    const policy={allowPrivate:true,proxyCa:ca,probeCa:ca,resolve:async(host:string)=>{dnsQueries.push(host);return [{address:'127.0.0.1',family:4}];}};
    for(const scheme of ['http','https'] as const)for(const auth of [false,true]){
      const proxy=scheme==='https'?httpsServer({key,cert}):httpServer();tunnel(proxy,probePort,auth);const port=await listen(proxy);
      const endpoint={scheme,host:'localhost',port,...(auth?{username:'proxy-user',password:'proxy-password'}:{})};
      const result=await checkProxy(endpoint,`http://probe.test:${probePort}/ip`,policy);assert.equal(result.state,'HEALTHY',`${scheme}/${auth}: ${result.errorCode}`);assert.equal(result.egressIp,'203.0.113.19');
      if(auth){const before=probeRequests;const failed=await checkProxy({...endpoint,password:'wrong'},`http://probe.test:${probePort}/ip`,policy);assert.equal(failed.state,'UNAVAILABLE');assert.equal(failed.errorCode,'PROXY_AUTH_REJECTED');assert.equal(probeRequests,before,'failure must not retry directly');}
    }
    for(const auth of [false,true]){
      const port=await listen(socks(probePort,auth));const endpoint={scheme:'socks5' as const,host:'localhost',port,...(auth?{username:'proxy-user',password:'proxy-password'}:{})};
      const result=await checkProxy(endpoint,`http://probe.test:${probePort}/ip`,policy);assert.equal(result.state,'HEALTHY',result.errorCode??'');
      if(auth){const before=probeRequests;assert.equal((await checkProxy({...endpoint,password:'wrong'},`http://probe.test:${probePort}/ip`,policy)).errorCode,'PROXY_AUTH_REJECTED');assert.equal(probeRequests,before);}
    }
    assert.ok(hosts.every(host=>host==='probe.test'));assert.ok(dnsQueries.every(host=>host==='localhost'),'target DNS must remain at the proxy');
    const ipv6Port=await listen(socks(probePort,false),'::1');assert.equal((await checkProxy({scheme:'socks5',host:'::1',port:ipv6Port},`http://probe.test:${probePort}/ip`,policy)).state,'HEALTHY');
    const secureProbe=httpsServer({key,cert},(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ip:'2001:4860:4860::8888'}));});
    const securePort=await listen(secureProbe),secureProxy=httpServer();tunnel(secureProxy,securePort,false);const proxyPort=await listen(secureProxy);
    assert.equal((await checkProxy({scheme:'http',host:'localhost',port:proxyPort},`https://localhost:${securePort}/`,policy)).state,'HEALTHY');
    assert.equal((await checkProxy({scheme:'http',host:'localhost',port:proxyPort},`https://localhost:${securePort}/`,{...policy,probeCa:undefined})).state,'UNAVAILABLE','untrusted target TLS must fail');
  }finally{for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise<void>(done=>server.close(()=>done()))));await rm(directory,{recursive:true,force:true});}
});
