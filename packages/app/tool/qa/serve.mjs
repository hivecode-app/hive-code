// Serves a web build with hq next to it, like Caddy does in production: the files at /, and /hq/*
// (HTTP and the WebSocket) passed to an hq on this machine (a QA sandbox: packages/hq/test/qa-sandbox.mts).
// Listen on 127.0.0.2: the app treats localhost/127.0.0.1 as "use HQ_URL", any other host as "<origin>/hq".
// Usage: node tool/qa/serve.mjs <build/web dir> [port=8099] [hq port=7499]
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'build/web');
const port = Number(process.argv[3] ?? 8099);
const hqPort = Number(process.argv[4] ?? 7499);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/hq/')) {
    const up = http.request({ host: '127.0.0.1', port: hqPort, path: req.url.slice(3), method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  let f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});

// The WebSocket: hand the raw upgrade to hq with the /hq prefix taken off.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/hq/')) return socket.destroy();
  const up = net.connect(hqPort, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url.slice(3)} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(port, '127.0.0.2', () => console.log(`http://127.0.0.2:${port}/ (hq on ${hqPort})`));
