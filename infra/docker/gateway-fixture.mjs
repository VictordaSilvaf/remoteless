// Deliberately restricted diagnostic proxy. Real upstream proxy support belongs to phase 2.
import {createServer, request as httpRequest} from 'node:http';
import {chmod, unlink, writeFile} from 'node:fs/promises';
const path = '/proxy/egress.sock';
await unlink(path).catch(error => {if (error.code !== 'ENOENT') throw error;});
const server = createServer((req, res) => {
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(403).end(); return; }
  if (target.protocol !== 'http:' || target.hostname !== 'fixture.test' || target.port || target.username || target.password || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(403).end(); return; }
  const upstream = httpRequest({hostname: 'fixture', port: 8080, path: `${target.pathname}${target.search}`, method: req.method, headers: {host: 'fixture.test'}}, response => {res.writeHead(response.statusCode, response.headers); response.pipe(res);});
  upstream.setTimeout(3000, () => upstream.destroy());
  upstream.on('error', () => {res.writeHead(502).end();});
  upstream.end();
});
server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
server.listen(path, async () => {await chmod(path, 0o600); await writeFile('/tmp/gateway-ready', 'ready');});
