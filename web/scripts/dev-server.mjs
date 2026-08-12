import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../dist/', import.meta.url).pathname;
const assets = new URL('../../assets/creatures/mobile/', import.meta.url).pathname;
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png' };
createServer(async (req,res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      const upstream = await fetch(`http://127.0.0.1:4001${url.pathname}${url.search}`, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json', 'x-player-id': req.headers['x-player-id'] ?? '' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      });
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const isCreature = /^\/creatures\/PG-\d{3}\.png$/.test(url.pathname);
    const base = isCreature ? assets : root;
    const relative = isCreature ? url.pathname.slice('/creatures/'.length) : url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(base, relative));
    if (!file.startsWith(base) || !(await stat(file)).isFile()) throw new Error('not found');
    res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
    res.setHeader('x-content-type-options','nosniff');
    res.end(await readFile(file));
  } catch { res.statusCode=404; res.end('Not found'); }
}).listen(5173, () => console.log('PunchGrow web: http://localhost:5173'));
