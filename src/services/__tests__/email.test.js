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

Module._load = function (request, parent, ...rest) {
  if (request === 'axios' && parent && parent.filename && parent.filename.endsWith('/email.js')) {
    return {
      post: async (_url, payload) => {
        lastPayload = payload;
        if (stubError) throw stubError;
        return stubResponse;
      },
    };
  }
  return origLoad.apply(this, [request, parent, ...rest]);
};

// Now require the module under test (axios stub will be picked up).
const { sendEmail } = require('../email');

beforeEach(() => {
  lastPayload = null;
  stubResponse = { data: { data: { succeeded: 1 } } };
  stubError = null;
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
    const ok = await sendEmail({
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
    assert.equal(ok, true);
    assert.ok(lastPayload, 'expected payload');
    assert.deepEqual(lastPayload.to, ['owner@example.com']);
    // sanity check: no 'Display Name <email>' format anywhere in to
    assert.doesNotMatch(JSON.stringify(lastPayload.to), /<|>/);
  });

  test('REGRESSION: comma in businessName does not break the to: field', async () => {
    // The lkv363od bug: SMTP2GO 400'd because the comma split the entry.
    const ok = await sendEmail({
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
    assert.equal(ok, true);
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

  test('SMTP2GO HTTP error -> returns false (does not throw)', async () => {
    stubError = Object.assign(new Error('http 400'), {
      response: { data: { error: 'bad payload' } },
    });
    const ok = await sendEmail({
      site: { businessName: 'B', ownerEmail: 'owner@example.com' },
      site_id: 's1',
      name: 'C',
      email: 'cx@x.invalid',
      message: 'M',
      form_type: 'contact',
    });
    assert.equal(ok, false);
  });

  test('SMTP2GO succeeded=0 -> returns false (delivery did not happen)', async () => {
    stubResponse = { data: { data: { succeeded: 0 } } };
    const ok = await sendEmail({
      site: { businessName: 'B', ownerEmail: 'owner@example.com' },
      site_id: 's1',
      name: 'C',
      email: 'cx@x.invalid',
      message: 'M',
      form_type: 'contact',
    });
    assert.equal(ok, false);
  });
});

// Restore module loader at the end so other tests aren't affected.
process.on('exit', () => {
  Module._resolveFilename = origResolve;
  Module._load = origLoad;
});
