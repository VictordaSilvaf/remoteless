import {createServer,request} from 'node:http';
import {chmod,unlink,writeFile} from 'node:fs/promises';
const socket='/proxy/egress.sock';
await unlink(socket).catch(error=>{if(error.code!=='ENOENT')throw error;});
const server=createServer((req,res)=>{
  let target;try{target=new URL(req.url);}catch{res.writeHead(403).end();return;}
  if(target.protocol!=='http:'||!['fixture.test','canvas.test'].includes(target.hostname)||target.port||target.username||target.password||!['GET','HEAD','POST'].includes(req.method)){res.writeHead(403).end();return;}
  if(Number(req.headers['content-length']??0)>16384){res.writeHead(413).end();return;}
  const headers={host:target.hostname};
  for(const name of ['content-type','cookie','origin'])if(req.headers[name])headers[name]=req.headers[name];
  const upstream=request({hostname:'fixture',port:8080,path:target.pathname+target.search,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  let bytes=0;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384){upstream.destroy();req.destroy();}});
  upstream.setTimeout(5000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
});
server.on('connect',(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
server.listen(socket,async()=>{await chmod(socket,0o600);await writeFile('/tmp/gateway-ready','ready');});
