import {createServer} from 'node:http';
createServer((_req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end('<!doctype html><html><head><title>MSM isolation fixture</title></head><body><h1>Fixture de isolamento</h1><p id="result">proxy-only</p></body></html>');
}).listen(8080, '0.0.0.0');
