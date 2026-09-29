'use strict';
// Local web server: static UI from public/ plus a small JSON API.
//
// The API itself lives in lib/api.js (also served on Vercel by api/*.js).
//
// Binds to 127.0.0.1 only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handler } = require('./lib/api');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC, `.${rel}`);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handler(req, res);
  serveStatic(res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Football charts running at http://localhost:${PORT}  (Ctrl+C to stop)`);
});
