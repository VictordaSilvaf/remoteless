import {createServer,createConnection,type Socket} from 'node:net';

/** Test-only transport: TLS remains end-to-end between LocalClient and the API. */
export async function installationBridge() {
  const connections=new Set<Socket>();
  const server=createServer(client=>{
    connections.add(client);
    const upstream=createConnection({host:'api',port:8443});
    upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
    client.pipe(upstream).pipe(client);
    client.on('close',()=>{upstream.destroy();connections.delete(client);});
  });
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(17643,'127.0.0.1',done);});
  return async()=>{for(const connection of connections)connection.destroy();await new Promise<void>(done=>server.close(()=>done()));};
}
