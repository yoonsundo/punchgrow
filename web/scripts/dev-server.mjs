import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../dist/', import.meta.url).pathname;
const assets = new URL('../../assets/creatures/mobile/', import.meta.url).pathname;
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png' };
export const DEV_HOST = '127.0.0.1';
const RESPONSE_HEADER_ALLOWLIST = ['content-type', 'cache-control', 'x-content-type-options', 'referrer-policy'];

export function proxyHeaders(headers) {
  const forwarded = {};
  for (const name of ['content-type', 'authorization']) {
    const value = headers[name];
    if (typeof value === 'string') forwarded[name] = value;
  }
  return forwarded;
}

export function createDevServer({ upstreamBase = 'http://127.0.0.1:4001' } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      try {
        const upstream = await fetch(`${upstreamBase}${url.pathname}${url.search}`, {
          method: req.method,
          headers: proxyHeaders(req.headers),
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
          duplex: 'half',
        });
        res.statusCode = upstream.status;
        for (const name of RESPONSE_HEADER_ALLOWLIST) {
          const value = upstream.headers.get(name);
          if (value !== null) res.setHeader(name, value);
        }
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.statusCode = 502;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Bad Gateway');
      }
      return;
    }
    try {
      const isCreature = /^\/creatures\/PG-\d{3}\.png$/.test(url.pathname);
      const base = isCreature ? assets : root;
      let relative;
      if (isCreature) {
        relative = url.pathname.slice('/creatures/'.length);
      } else if (url.pathname === '/') {
        relative = 'index.html';
      } else {
        relative = url.pathname.slice(1);
      }
      const file = normalize(join(base, relative));
      if (!file.startsWith(base) || !(await stat(file)).isFile()) throw new Error('not found');
      res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(await readFile(file));
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDevServer().listen(5173, DEV_HOST, () => console.log(`PunchGrow web: http://${DEV_HOST}:5173`));
}
