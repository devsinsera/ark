// The Comb — unified launcher server for The Hive (Pi 5).
//
// Serves the launcher SPA + a couple of small JSON endpoints. Runs
// on the Pi itself (systemd: the-comb.service) so Chromium kiosk can
// hit http://localhost:8080 without depending on anything external.
//
// Standard library only — no deps. Run with: node server.mjs

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function primaryIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (name === 'lo' || name.startsWith('lo')) continue;
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

const server = createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // health/version JSON
  if (u.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      app: 'the-comb',
      version: VERSION,
      host: os.hostname(),
      ip: primaryIp(),
      uptime_s: Math.round(process.uptime()),
    }));
  }

  // Static files from public/
  let rel = u.pathname === '/' ? '/index.html' : u.pathname;
  if (rel.includes('..')) {
    res.writeHead(400); return res.end('bad path');
  }
  const filePath = path.join(PUBLIC_DIR, rel);
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type':  MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    return createReadStream(filePath).pipe(res);
  }

  // SPA fallback — any unknown path returns index.html so client-side
  // routing can resolve it.
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (existsSync(indexFile)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return createReadStream(indexFile).pipe(res);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[the-comb v${VERSION}] listening on http://${HOST}:${PORT} (ip ${primaryIp()})`);
});
