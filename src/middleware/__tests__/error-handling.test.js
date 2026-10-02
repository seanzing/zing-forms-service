/**
 * Tests for src/middleware/error-handling.js and its wiring in src/index.js.
 *
 * Reproduces the exact real-world failure Sean reported 2026-10-02:
 * a form submission on a live Pixel site threw
 * `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
 * in the browser console. Root cause traced to src/index.js having no
 * catch-all 404 handler and no global error-handling middleware — both
 * gaps mean Express's BUILT-IN defaults (which return an HTML error
 * page) fire instead, and the inline form-handler script shipped on
 * every Pixel site calls `res.json()` unconditionally with no
 * try/catch around the parse itself.
 *
 * This file builds a full app (mirroring src/index.js's middleware
 * order) rather than mounting submitRouter alone, specifically so the
 * express.json() size-limit-exceeded and malformed-JSON cases — which
 * throw INSIDE express.json() itself, before any route handler ever
 * runs — are exercised through the real pipeline.
 *
 * Run: node --test src/middleware/__tests__/error-handling.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { notFoundHandler, globalErrorHandler } = require('../error-handling');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // A couple of minimal real routes so 404 behavior is meaningfully
  // distinct from "every path 404s" — mirrors index.js having
  // /health, /submit, /admin mounted before the fallback handlers.
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.post('/submit', (req, res) => res.json({ success: true }));
  // A route that deliberately throws synchronously, to exercise
  // globalErrorHandler's generic (non-body-parser) path.
  app.get('/boom', () => {
    throw new Error('deliberate test failure');
  });

  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function rawRequest({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('notFoundHandler', () => {
  test('unmatched route returns JSON, not HTML', async () => {
    const res = await rawRequest({ method: 'GET', path: '/this-route-does-not-exist' });
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.text); // must not throw
    assert.match(body.error, /Not found/);
    assert.match(body.error, /\/this-route-does-not-exist/);
  });

  test('real routes still work and are not shadowed by the 404 handler', async () => {
    const res = await rawRequest({ method: 'GET', path: '/health' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true });
  });
});

describe('globalErrorHandler', () => {
  test('malformed JSON body on a JSON route returns JSON 400, not an HTML error page', async () => {
    // This is the body-parser throw-before-the-route-handler case —
    // express.json() itself throws a SyntaxError; submit.js's own
    // try/catch never even runs.
    const malformed = Buffer.from('{ this is not valid json', 'utf8');
    const res = await rawRequest({
      method: 'POST',
      path: '/submit',
      headers: { 'Content-Type': 'application/json', 'Content-Length': malformed.length },
      body: malformed,
    });
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.text); // the exact assertion that was failing for real users
    assert.equal(body.error, 'Malformed request body.');
  });

  test('oversized JSON body returns JSON 413, not an HTML error page', async () => {
    // Exceeds the 2mb limit set in index.js — same throw-before-the-
    // route-handler shape as malformed JSON above.
    const bigValue = 'x'.repeat(3 * 1024 * 1024); // 3MB > 2MB limit
    const payload = Buffer.from(JSON.stringify({ message: bigValue }), 'utf8');
    const res = await rawRequest({
      method: 'POST',
      path: '/submit',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      body: payload,
    });
    assert.equal(res.status, 413);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.text);
    assert.equal(body.error, 'Request body too large.');
  });

  test('a route that throws synchronously still returns JSON 500', async () => {
    const res = await rawRequest({ method: 'GET', path: '/boom' });
    assert.equal(res.status, 500);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.text);
    assert.equal(body.error, 'deliberate test failure');
  });

  test('well-formed small requests are completely unaffected', async () => {
    const res = await requestJsonHelper({ foo: 'bar' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { success: true });
  });
});

function requestJsonHelper(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return rawRequest({
    method: 'POST',
    path: '/submit',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    body,
  });
}
