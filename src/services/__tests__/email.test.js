/**
 * Tests for src/services/email.js. Specifically guards the comma-in-display-name
 * bug that took out lkv363od ('You Mess Up, We Clean Up') and would have hit
 * any business with a comma in its display name once a real submission came in.
 *
 * Diagnosed 2026-06-29: SMTP2GO's `to:` field treated the comma in
 *   'You Mess Up, We Clean Up <youmessup670@gmail.com>'
 * as a recipient separator, which fails its 'no angle-addr' validator
 * because the second half ('We Clean Up <email>') has no leading mailbox.
 *
 * Run: node --test src/services/__tests__/email.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub axios before requiring email.js so we can inspect the SMTP2GO payload.
const Module = require('module');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

let lastPayload = null;
let stubResponse = { data: { data: { succeeded: 1 } } };
let stubError = null;
// Multi-attempt harness: if set, drives per-attempt responses/errors.
// Array length determines the max attempts we'll respond to. Absent = use
// stubResponse/stubError for every attempt.
let stubSequence = null;
let callCount = 0;

Module._load = function (request, parent, ...rest) {
  if (request === 'axios' && parent && parent.filename && parent.filename.endsWith('/email.js')) {
    return {
      post: async (_url, payload) => {
        lastPayload = payload;
        callCount++;
        if (stubSequence) {
          const step = stubSequence[Math.min(callCount - 1, stubSequence.length - 1)];
          if (step.error) throw step.error;
          return step.response;
        }
        if (stubError) throw stubError;
        return stubResponse;
      },
    };
  }
  return origLoad.apply(this, [request, parent, ...rest]);
};

// Make retry delays instantaneous for tests so the 3-attempt case doesn't
// sleep 8 seconds. Must be set BEFORE requiring ../email (constants are
// read once at module load time).
process.env.EMAIL_RETRY_DELAYS_MS = '0,0,0';

// Now require the module under test (axios stub will be picked up).
const { sendEmail } = require('../email');

beforeEach(() => {
  lastPayload = null;
  stubResponse = { data: { data: { succeeded: 1 } } };
  stubError = null;
  stubSequence = null;
  callCount = 0;
  process.env.SMTP2GO_API_KEY = 'test-key';
  process.env.SMTP2GO_FROM_EMAIL = 'noreply@zing-work.com';
  process.env.SMTP2GO_FROM_NAME = 'ZING Forms';
});
afterEach(() => {
  delete process.env.SMTP2GO_API_KEY;
  delete process.env.SMTP2GO_FROM_EMAIL;
  delete process.env.SMTP2GO_FROM_NAME;
});

describe('sendEmail — recipient formatting', () => {
  test('to: is an array with the bare email (no display name)', async () => {
    const res = await sendEmail({
      site: {
        businessName: 'Plain Business',
        ownerEmail: 'owner@example.com',
      },
      site_id: 'plain1',
      name: 'Jane Customer',
      email: 'jane@customer.invalid',
      phone: '5555551234',
      message: 'Hello',
      form_type: 'contact',
    });
    assert.equal(res.sent, true);
    assert.equal(res.error, null);
    assert.equal(res.attempts, 1);
    assert.ok(lastPayload, 'expected payload');
    assert.deepEqual(lastPayload.to, ['owner@example.com']);
    // sanity check: no 'Display Name <email>' format anywhere in to
    assert.doesNotMatch(JSON.stringify(lastPayload.to), /<|>/);
  });

  test('REGRESSION: comma in businessName does not break the to: field', async () => {
    // The lkv363od bug: SMTP2GO 400'd because the comma split the entry.
    const res = await sendEmail({
      site: {
        businessName: 'You Mess Up, We Clean Up',
        ownerEmail: 'youmessup670@gmail.com',
      },
      site_id: 'lkv363od',
      name: 'Test Customer',
      email: 'cx@test.invalid',
      message: 'Cleanup quote please',
      form_type: 'contact',
    });
    assert.equal(res.sent, true);
    assert.deepEqual(lastPayload.to, ['youmessup670@gmail.com']);
  });

  test('businessName still appears in subject (so the operator knows the source)', async () => {
    await sendEmail({
      site: {
        businessName: 'Martinez Outdoor Storage',
        ownerEmail: 'info@martinezoutdoorstorage.com',
      },
      site_id: 'mkd3ar7r',
      name: 'Jane Customer',
      email: 'jane@example.com',
      message: 'Inquiry',
      form_type: 'contact',
    });
    assert.match(lastPayload.subject, /Martinez Outdoor Storage/);
  });

  test('Reply-To header is set to the customer email when present', async () => {
    await sendEmail({
      site: { businessName: 'B', ownerEmail: 'owner@example.com' },
      site_id: 's1',
      name: 'C',
      email: 'reply-here@cx.invalid',
      message: 'Test',
      form_type: 'contact',
    });
    const replyTo = lastPayload.custom_headers.find((h) => h.header === 'Reply-To');
    assert.ok(replyTo, 'expected Reply-To header');
    assert.equal(replyTo.value, 'reply-here@cx.invalid');
  });

  test('SMTP2GO 4xx error -> returns { sent:false, error } and does NOT retry', async () => {
    stubError = Object.assign(new Error('http 400'), {
      response: { status: 400, data: { error: 'bad payload' } },
    });
    const res = await sendEmail({
      site: { businessName: 'B', ownerEmail: 'owner@example.com' },
      site_id: 's1',
      name: 'C',
      email: 'cx@x.invalid',
      message: 'M',
      form_type: 'contact',
    });
    assert.equal(res.sent, false);
    assert.equal(res.attempts, 1, '4xx must not retry');
    assert.match(res.error, /bad payload/);
  });

  test('SMTP2GO succeeded=0 -> returns { sent:false, error } and does NOT retry', async () => {
    stubResponse = { data: { data: { succeeded: 0 } } };
    const res = await sendEmail({
      site: { businessName: 'B', ownerEmail: 'owner@example.com' },
      site_id: 's1',
      name: 'C',
      email: 'cx@x.invalid',
      message: 'M',
      form_type: 'contact',
    });
    assert.equal(res.sent, false);
    assert.equal(res.attempts, 1);
  });

  test('transient network error on first attempt -> retries and succeeds on second', async () => {
    stubSequence = [
      { error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
      { response: { data: { data: { succeeded: 1 } } } },
    ];
    const res = await sendEmail({
      site: { businessName: 'B', ownerEmail: 'owner@example.com' },
      site_id: 's1',
      name: 'C',
      email: 'cx@x.invalid',
      message: 'M',
      form_type: 'contact',
    });
    assert.equal(res.sent, true, 'second attempt should succeed');
    assert.equal(res.attempts, 2, 'should have retried once');
  });

  test('SMTP2GO 5xx -> retries up to 3 times, gives up with { sent:false }', async () => {
    const err5xx = () => Object.assign(new Error('http 502'), {
      response: { status: 502, data: { error: 'upstream borked' } },
    });
    stubSequence = [{ error: err5xx() }, { error: err5xx() }, { error: err5xx() }];
    const res = await sendEmail({
      site: { businessName: 'B', ownerEmail: 'owner@example.com' },
      site_id: 's1',
      name: 'C',
      email: 'cx@x.invalid',
      message: 'M',
      form_type: 'contact',
    });
    assert.equal(res.sent, false);
    assert.equal(res.attempts, 3, 'should attempt exactly 3 times before giving up');
    assert.match(res.error, /borked|502/);
  });
});

// Restore module loader at the end so other tests aren't affected.
process.on('exit', () => {
  Module._resolveFilename = origResolve;
  Module._load = origLoad;
});
