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
const { sendEmail, _internals } = require('../email');

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

describe('sendEmail — extra field rendering (rentamover 2026-08-20 fix)', () => {
  const baseCall = (extra) => sendEmail({
    site: { businessName: 'Rentamover', ownerEmail: 'owner@rentamover.invalid' },
    site_id: '2p3cout6',
    name: 'test Wooten',
    email: 'mb200688@yahoo.invalid',
    phone: '2293761453',
    message: '',
    form_type: 'quote',
    extra,
  });

  test('renders every non-empty field in `extra` as its own table row', async () => {
    await baseCall({
      movetype: 'Local move',
      bedrooms: '3',
      referral: 'facebook',
    });
    const html = lastPayload.html_body;
    assert.match(html, /Move ?type|Movetype/i, 'expected a Movetype row label');
    assert.match(html, />Local move</);
    assert.match(html, />3</);
    assert.match(html, />facebook</);
  });

  test('skips null / undefined / empty-string / empty-object extras', async () => {
    await baseCall({
      keep: 'visible',
      empty_string: '',
      whitespace_only: '   ',
      null_field: null,
      undef_field: undefined,
      empty_object: {},
    });
    const html = lastPayload.html_body;
    assert.match(html, />visible</);
    // None of the empty-field labels should appear anywhere.
    assert.doesNotMatch(html, /Empty String/i);
    assert.doesNotMatch(html, /Whitespace Only/i);
    assert.doesNotMatch(html, /Null Field/i);
    assert.doesNotMatch(html, /Undef Field/i);
    assert.doesNotMatch(html, /Empty Object/i);
  });

  test('humanizes field names: snake_case, kebab-case, camelCase', async () => {
    // humanizeKey is exported via _internals for direct assertions.
    assert.equal(_internals.humanizeKey('move_type'), 'Move Type');
    assert.equal(_internals.humanizeKey('from-residence'), 'From Residence');
    assert.equal(_internals.humanizeKey('timing_notes'), 'Timing Notes');
    assert.equal(_internals.humanizeKey('timingNotes'), 'Timing Notes');
    // `movetype` is a single lowercase token — no separator to split on,
    // so it becomes "Movetype". Documented so the fix is predictable.
    assert.equal(_internals.humanizeKey('movetype'), 'Movetype');

    // And confirm they end up in the rendered HTML with those labels.
    await baseCall({
      move_type: 'Local move',
      'from-residence': 'House',
      timing_notes: 'Prefer weekend',
    });
    const html = lastPayload.html_body;
    assert.match(html, />Move Type</);
    assert.match(html, />From Residence</);
    assert.match(html, />Timing Notes</);
  });

  test('boolean values render as Yes / No', async () => {
    await baseCall({ fragile: true, packing: false });
    const html = lastPayload.html_body;
    assert.match(html, /Fragile[\s\S]*?>Yes</);
    assert.match(html, /Packing[\s\S]*?>No</);
  });

  test('handles the real rentamover shape (17 extras, empty-object scope, empty strings)', async () => {
    await baseCall({
      boxes: '20',
      notes: '',
      scope: {},
      stairs: 'Elevator',
      timing: 'No',
      details: '',
      fragile: 'Yes',
      packing: 'No',
      bedrooms: '3',
      movedate: '2026-09-05',
      movetype: 'Local move',
      referral: 'facebook',
      unpacking: 'No',
      'timing-notes': '',
      'to-residence': 'House',
      'from-residence': 'House',
    });
    const html = lastPayload.html_body;

    // Section header appears exactly once.
    const headerMatches = html.match(/Additional Details/g) || [];
    assert.equal(headerMatches.length, 1, 'section header should appear once');

    // Every non-empty field label + value is present.
    const expectedRows = [
      ['Boxes', '20'],
      ['Stairs', 'Elevator'],
      ['Timing', 'No'],
      ['Fragile', 'Yes'],
      ['Packing', 'No'],
      ['Bedrooms', '3'],
      ['Movedate', '2026-09-05'],
      ['Movetype', 'Local move'],
      ['Referral', 'facebook'],
      ['Unpacking', 'No'],
      ['To Residence', 'House'],
      ['From Residence', 'House'],
    ];
    for (const [label, value] of expectedRows) {
      assert.match(html, new RegExp(`>${label}<`), `missing label: ${label}`);
      assert.match(html, new RegExp(`>${value}<`), `missing value: ${value}`);
    }

    // Empty ones are skipped entirely.
    for (const skip of ['Notes', 'Scope', 'Details', 'Timing Notes']) {
      assert.doesNotMatch(
        html,
        new RegExp(`>${skip}<`),
        `empty field "${skip}" should not render a row`,
      );
    }
  });

  test('XSS-safe: extra values with <script> tags get escaped', async () => {
    await baseCall({
      referral: '<script>alert(1)</script>',
      note_key: '"onclick="evil"',
    });
    const html = lastPayload.html_body;
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    // attribute-injection attempt should have its quotes escaped
    assert.match(html, /&quot;onclick=&quot;evil&quot;/);
  });

  test('extras section is omitted entirely when extra is null / undefined / empty', async () => {
    await baseCall(null);
    assert.doesNotMatch(lastPayload.html_body, /Additional Details/);

    await baseCall(undefined);
    assert.doesNotMatch(lastPayload.html_body, /Additional Details/);

    await baseCall({});
    assert.doesNotMatch(lastPayload.html_body, /Additional Details/);

    // All-empty values also produce no section.
    await baseCall({ a: '', b: null, c: {} });
    assert.doesNotMatch(lastPayload.html_body, /Additional Details/);
  });
});

// Restore module loader at the end so other tests aren't affected.
process.on('exit', () => {
  Module._resolveFilename = origResolve;
  Module._load = origLoad;
});
