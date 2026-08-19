import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDevServer, DEV_HOST, proxyHeaders } from './dev-server.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('development listener defaults to IPv4 loopback', () => {
  assert.equal(DEV_HOST, '127.0.0.1');
});

test('proxy forwards only content-type and authorization', () => {
  assert.deepEqual(proxyHeaders({
    'content-type': 'application/json',
    authorization: 'Bearer signed-session',
    'x-player-id': 'stale-player',
    'x-collector-secret': 'must-not-cross-browser-proxy',
    cookie: 'private=value',
  }), {
    'content-type': 'application/json',
    authorization: 'Bearer signed-session',
  });
});

test('proxy omits absent allowlisted headers', () => {
  assert.deepEqual(proxyHeaders({ 'x-collector-secret': 'blocked' }), {});
});

test('nginx proxy disables implicit request-header forwarding', async () => {
  const nginx = await readFile(new URL('../nginx.conf', import.meta.url), 'utf8');
  const apiLocation = nginx.match(/location \/api\/ \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.match(apiLocation, /proxy_pass_request_headers off;/);
  assert.match(apiLocation, /proxy_set_header Content-Type \$http_content_type;/);
  assert.match(apiLocation, /proxy_set_header Authorization \$http_authorization;/);
  assert.doesNotMatch(apiLocation, /X-Collector-Secret|x-collector-secret/);
});

test('proxy forwards only safe response headers from an injectable upstream', async () => {
  const upstream = createServer((_req, res) => {
    res.statusCode = 201;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('set-cookie', 'secret=value');
    res.setHeader('x-upstream-secret', 'blocked');
    res.end('{"ok":true}');
  });
  const upstreamBase = await listen(upstream);
  const proxy = createDevServer({ upstreamBase });
  const proxyBase = await listen(proxy);
  try {
    const response = await fetch(`${proxyBase}/api/probe`);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('x-upstream-secret'), null);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('upstream transport failures are 502 while static misses remain 404', async () => {
  const unavailable = createServer();
  const unavailableBase = await listen(unavailable);
  await close(unavailable);
  const proxy = createDevServer({ upstreamBase: unavailableBase });
  const proxyBase = await listen(proxy);
  try {
    assert.equal((await fetch(`${proxyBase}/api/unavailable`)).status, 502);
    assert.equal((await fetch(`${proxyBase}/missing-static-file`)).status, 404);
  } finally {
    await close(proxy);
  }
});
