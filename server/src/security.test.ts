import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedCorsOrigin, CORS_ALLOW_HEADERS, collectorSecretMatches, loadSecurityConfig, SessionAdmissionLimiter } from './security.js';

test('security defaults stay loopback-only and local-authenticated', () => {
  const config = loadSecurityConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.authMode, 'local');
  assert.equal(config.collectorSecretHash, undefined);
});

test('non-local auth modes are rejected until external auth exists', () => {
  assert.throws(() => loadSecurityConfig({ AUTH_MODE: 'production' }), /AUTH_MODE must be local/);
});

test('collector secrets must be long and are compared through fixed-length hashes', () => {
  assert.throws(() => loadSecurityConfig({ COLLECTOR_SECRET: '' }), /COLLECTOR_SECRET must be at least 32 bytes/);
  assert.throws(() => loadSecurityConfig({ COLLECTOR_SECRET: 'short-secret' }), /at least 32 bytes/);

  const secret = 'test-collector-secret-with-32-bytes-minimum';
  const config = loadSecurityConfig({ COLLECTOR_SECRET: secret });
  assert.ok(config.collectorSecretHash);
  assert.equal(collectorSecretMatches(secret, config.collectorSecretHash), true);
  assert.equal(collectorSecretMatches('wrong', config.collectorSecretHash), false);
  assert.equal(collectorSecretMatches(undefined, config.collectorSecretHash), false);
});

test('explicit session secrets use the same strength requirements', () => {
  assert.throws(() => loadSecurityConfig({ SESSION_SECRET: '' }), /SESSION_SECRET must be at least 32 bytes/);
  assert.throws(() => loadSecurityConfig({ SESSION_SECRET: 'short-secret' }), /SESSION_SECRET must be at least 32 bytes/);
  const configured = 'test-session-secret-with-32-bytes-minimum';
  assert.equal(loadSecurityConfig({ SESSION_SECRET: configured }).sessionSecret, configured);
});

test('CORS accepts exact configured origins only and never allows collector credentials', () => {
  const configured = 'http://localhost:5173, https://app.example.test';
  assert.equal(allowedCorsOrigin(undefined, configured), undefined);
  assert.equal(allowedCorsOrigin('http://localhost:5173', configured), 'http://localhost:5173');
  assert.equal(allowedCorsOrigin('https://app.example.test', configured), 'https://app.example.test');
  assert.equal(allowedCorsOrigin('http://localhost:5174', configured), undefined);
  assert.equal(allowedCorsOrigin('http://127.0.0.1:5173', configured), undefined);
  assert.equal(CORS_ALLOW_HEADERS, 'content-type,authorization');
});

test('session admission is limited per address and globally within a window', () => {
  const limiter = new SessionAdmissionLimiter(1_000, 3, 2);
  assert.equal(limiter.admit('127.0.0.1', 1_000), true);
  assert.equal(limiter.admit('127.0.0.1', 1_001), true);
  assert.equal(limiter.admit('127.0.0.1', 1_002), false);
  assert.equal(limiter.admit('127.0.0.2', 1_003), true);
  assert.equal(limiter.admit('127.0.0.3', 1_004), false);
  assert.equal(limiter.admit('127.0.0.1', 2_001), true);
});
