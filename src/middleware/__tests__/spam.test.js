/**
 * Tests for src/middleware/spam.js — specifically the case-insensitive
 * human-labeled field normalization added after Naples Tennis (axce8w7k)
 * started shipping `"Full name"`, `"Email"`, `"Phone"` and getting rejected
 * with HTTP 400 `{"error":"name is required."}`.
 *
 * Also covers regression on Duda dmform-N and first_name+last_name paths.
 *
 * Run: node --test src/middleware/__tests__/spam.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateSubmission } = require('../spam');

function runMiddleware(body) {
  const req = { body, ip: '127.0.0.1' };
  let statusCode = 200;
  let jsonPayload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonPayload = payload; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  validateSubmission(req, res, next);
  return { req, statusCode, jsonPayload, nextCalled };
}

describe('validateSubmission — case-insensitive human labels', () => {
  test('"Full name" mirrors onto req.body.name', () => {
    const { req, nextCalled, statusCode } = runMiddleware({
      site_id: 'axce8w7k',
      'Full name': 'Alice',
      'Email': 'a@b.com',
      'Phone': '555',
    });
    assert.equal(nextCalled, true, 'next() should be called');
    assert.equal(statusCode, 200);
    assert.equal(req.body.name, 'Alice');
  });

  test('"Email" mirrors onto req.body.email', () => {
    const { req, nextCalled } = runMiddleware({
      site_id: 'x',
      'Full name': 'Alice',
      'Email': 'a@b.com',
    });
    assert.equal(nextCalled, true);
    assert.equal(req.body.email, 'a@b.com');
  });

  test('"Phone" mirrors onto req.body.phone', () => {
    const { req, nextCalled } = runMiddleware({
      site_id: 'x',
      'Full name': 'Alice',
      'Phone': '555-1212',
    });
    assert.equal(nextCalled, true);
    assert.equal(req.body.phone, '555-1212');
  });

  test('"Message" mirrors onto req.body.message', () => {
    const { req, nextCalled } = runMiddleware({
      site_id: 'x',
      'Full name': 'Alice',
      'Email': 'a@b.com',
      'Message': 'hello there',
    });
    assert.equal(nextCalled, true);
    assert.equal(req.body.message, 'hello there');
  });

  test('original human-labeled keys are preserved (mirror, not replace)', () => {
    const { req } = runMiddleware({
      site_id: 'x',
      'Full name': 'Alice',
      'Email': 'a@b.com',
      'Phone': '555',
    });
    assert.equal(req.body['Full name'], 'Alice');
    assert.equal(req.body['Email'], 'a@b.com');
    assert.equal(req.body['Phone'], '555');
  });

  test('existing lowercase canonical is NOT overwritten by capitalized sibling', () => {
    const { req } = runMiddleware({
      site_id: 'x',
      name: 'CanonicalWins',
      'Full name': 'Loser',
      email: 'canonical@x.com',
      'Email': 'loser@x.com',
      phone: '111',
      'Phone': '222',
    });
    assert.equal(req.body.name, 'CanonicalWins');
    assert.equal(req.body.email, 'canonical@x.com');
    assert.equal(req.body.phone, '111');
  });

  test('Naples repro end-to-end — no 400', () => {
    // Exact shape from the axce8w7k repro in the task description.
    const { statusCode, jsonPayload, nextCalled } = runMiddleware({
      site_id: 'axce8w7k',
      'Full name': 'Test',
      'Email': 't@t.com',
      'Phone': '555',
    });
    assert.equal(nextCalled, true, `expected next(), got ${statusCode} ${JSON.stringify(jsonPayload)}`);
    assert.equal(statusCode, 200);
    assert.equal(jsonPayload, null);
  });

  test('case-insensitive variants: FULL NAME, YourName, EMAIL ADDRESS', () => {
    const r1 = runMiddleware({ site_id: 'x', 'FULL NAME': 'Bob', 'EMAIL': 'b@b.com' });
    assert.equal(r1.req.body.name, 'Bob');
    assert.equal(r1.req.body.email, 'b@b.com');

    const r2 = runMiddleware({ site_id: 'x', 'YourName': 'Carol', 'phone': '999' });
    assert.equal(r2.req.body.name, 'Carol');

    const r3 = runMiddleware({ site_id: 'x', 'Name': 'Dave', 'Email Address': 'd@d.com' });
    assert.equal(r3.req.body.name, 'Dave');
    assert.equal(r3.req.body.email, 'd@d.com');
  });
});

describe('validateSubmission — existing behavior (regression checks)', () => {
  test('first_name + last_name combined still works', () => {
    const { req, nextCalled } = runMiddleware({
      site_id: 'x',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'j@d.com',
    });
    assert.equal(nextCalled, true);
    assert.equal(req.body.name, 'Jane Doe');
  });

  test('Duda dmform-N + label-dmform-N still works', () => {
    const { req, nextCalled } = runMiddleware({
      site_id: 'x',
      'dmform-0': 'Jane Duda',
      'label-dmform-0': 'FULL NAME',
      'dmform-1': 'jd@example.com',
      'label-dmform-1': 'EMAIL',
      'dmform-2': '555-0000',
      'label-dmform-2': 'PHONE',
    });
    assert.equal(nextCalled, true);
    assert.equal(req.body.name, 'Jane Duda');
    assert.equal(req.body.email, 'jd@example.com');
    assert.equal(req.body.phone, '555-0000');
  });

  test('lowercase full_name still works', () => {
    const { req, nextCalled } = runMiddleware({
      site_id: 'x',
      full_name: 'Sam',
      email: 's@s.com',
    });
    assert.equal(nextCalled, true);
    assert.equal(req.body.name, 'Sam');
  });

  test('missing site_id still 400s', () => {
    const { statusCode, jsonPayload, nextCalled } = runMiddleware({
      'Full name': 'Alice', 'Email': 'a@b.com',
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 400);
    assert.match(jsonPayload.error, /site_id/);
  });

  test('missing name still 400s', () => {
    const { statusCode, jsonPayload, nextCalled } = runMiddleware({
      site_id: 'x', email: 'a@b.com',
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 400);
    assert.match(jsonPayload.error, /name/);
  });

  test('missing both email and phone still 400s', () => {
    const { statusCode, jsonPayload, nextCalled } = runMiddleware({
      site_id: 'x', 'Full name': 'Alice',
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 400);
    assert.match(jsonPayload.error, /email or phone/);
  });
});
