/**
 * Tests for src/routes/submit.js — specifically the 2026-08-26 Fix A work
 * that added multipart/form-data support so file uploads (resume PDFs,
 * photos of the scope of work, etc.) actually reach the operator instead
 * of getting stringified to `{}` on the client and dropped on the server.
 *
 * We stub three things at module-load time:
 *   1. axios (so email.js never actually calls SMTP2GO)
 *   2. ../services/sites (so we don't need Supabase / cache infra)
 *   3. ../services/submissions-store (so we don't need Supabase writes)
 *
 * Then we mount `submit.js` on a bare express app and drive it with
 * real HTTP requests via node's built-in http client.
 *
 * Run: node --test src/routes/__tests__/submit.test.js
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

// ── Module intercept ─────────────────────────────────────────────

const origLoad = Module._load;

let lastSmtpPayload = null;
let smtpResponse = { data: { data: { succeeded: 1 } } };
let smtpError = null;

let lastStoredRow = null;
let insertShouldThrow = false;

let stubSite = { ownerEmail: 'owner@example.invalid', businessName: 'Test Biz' };

Module._load = function (request, parent, ...rest) {
  // Stub axios only when required from email.js
  if (request === 'axios' && parent && parent.filename && parent.filename.endsWith('/email.js')) {
    return {
      post: async (_url, payload) => {
        lastSmtpPayload = payload;
        if (smtpError) throw smtpError;
        return smtpResponse;
      },
    };
  }
  // Stub the sites service
  if (request === '../services/sites') {
    return {
      getSite: async (_siteId) => stubSite,
    };
  }
  // Stub the submissions store
  if (request === '../services/submissions-store') {
    return {
      insertSubmission: async (row) => {
        lastStoredRow = row;
        if (insertShouldThrow) throw new Error('supabase down');
        return { id: 'test-id' };
      },
    };
  }
  return origLoad.apply(this, [request, parent, ...rest]);
};

// Make the email retry backoff instant so a 3-attempt failure test doesn't sleep 8s.
process.env.EMAIL_RETRY_DELAYS_MS = '0,0,0';
process.env.SMTP2GO_API_KEY = 'test-key';

// Bypass the express-rate-limit middleware for tests (10 submits / 15min
// would trip immediately). We monkey-patch it at load time.
require.cache[require.resolve('../../middleware/rateLimit')] = {
  exports: (req, _res, next) => next(),
  loaded: true,
  id: require.resolve('../../middleware/rateLimit'),
  filename: require.resolve('../../middleware/rateLimit'),
  children: [],
  paths: [],
};

// Now require the router (all module-load-time stubs are in place)
const express = require('express');
const submitRouter = require('../submit');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/submit', submitRouter);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  lastSmtpPayload = null;
  lastStoredRow = null;
  smtpResponse = { data: { data: { succeeded: 1 } } };
  smtpError = null;
  insertShouldThrow = false;
  stubSite = { ownerEmail: 'owner@example.invalid', businessName: 'Test Biz' };
});

// ── HTTP helpers ─────────────────────────────────────────────────

function requestJson(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return rawRequest({
    method: 'POST',
    path: '/submit',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    },
    body,
  });
}

/**
 * Build a minimal multipart/form-data body from a list of parts.
 * Each part is either {name, value} (text field) or
 * {name, filename, contentType, content:Buffer} (file part).
 */
function buildMultipart(parts) {
  const boundary = '----zingtest' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: ${p.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(p.content);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`,
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function requestMultipart(parts) {
  const { body, contentType } = buildMultipart(parts);
  return rawRequest({
    method: 'POST',
    path: '/submit',
    headers: {
      'Content-Type': contentType,
      'Content-Length': body.length,
    },
    body,
  });
}

function rawRequest({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers,
      },
      (res) => {
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(bufs).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch { /* not JSON, that's fine */ }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('POST /submit — JSON path (regression / no-files fast path)', () => {
  test('accepts JSON without any files and sends email', async () => {
    const res = await requestJson({
      site_id: 's1',
      name: 'Jane Applicant',
      email: 'jane@example.invalid',
      phone: '555-0000',
      'q-cdl': 'Yes',
      'q-moving': 'No',
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.ok(lastSmtpPayload, 'expected SMTP2GO call');
    // extras got rendered
    assert.match(lastSmtpPayload.html_body, />Q Cdl</);
    assert.match(lastSmtpPayload.html_body, />Yes</);
    // no attachments on the outbound email
    assert.equal(lastSmtpPayload.attachments, undefined);
    // submissions-store got the row with no attachments metadata
    assert.equal(lastStoredRow.attachments, null);
  });
});

describe('POST /submit — human question labels (Fix B, 2026-08-26)', () => {
  test('_field_labels JSON → email renders labels, DB row records the map, extras block hides the metadata key', async () => {
    const res = await requestJson({
      site_id: 's1',
      name: 'Jane Applicant',
      email: 'jane@example.invalid',
      phone: '555-0000',
      'q-cdl': 'Yes',
      'q-moving': 'No',
      bedrooms: '3',
      _field_labels: JSON.stringify({
        'q-cdl': 'Do you have a Class A license?',
        'q-moving': 'Do you have moving experience?',
      }),
    });
    assert.equal(res.status, 200);
    // Labels rendered.
    assert.match(lastSmtpPayload.html_body, />Do you have a Class A license\?</);
    assert.match(lastSmtpPayload.html_body, />Do you have moving experience\?</);
    // bedrooms had no label — falls through to humanizeKey.
    assert.match(lastSmtpPayload.html_body, />Bedrooms</);
    // The metadata key must NOT surface anywhere in the extras block.
    assert.doesNotMatch(lastSmtpPayload.html_body, /_field_labels/i);
    assert.doesNotMatch(lastSmtpPayload.html_body, /Field Labels/i);
    // DB row records the map verbatim.
    assert.deepEqual(lastStoredRow.field_labels, {
      'q-cdl': 'Do you have a Class A license?',
      'q-moving': 'Do you have moving experience?',
    });
    // And the extras bag DOES NOT contain _field_labels.
    assert.equal(lastStoredRow.extra._field_labels, undefined);
  });

  test('malformed _field_labels JSON → treated as empty, no crash, extras still humanize', async () => {
    const res = await requestJson({
      site_id: 's1',
      name: 'Jane Applicant',
      phone: '555-0000',
      'q-cdl': 'Yes',
      _field_labels: '{not valid json',
    });
    assert.equal(res.status, 200);
    // Falls back to humanizeKey.
    assert.match(lastSmtpPayload.html_body, />Q Cdl</);
    // DB row has null field_labels (empty map → stored as null).
    assert.equal(lastStoredRow.field_labels, null);
  });

  test('_field_labels present but empty object → humanize fallback for all keys', async () => {
    const res = await requestJson({
      site_id: 's1',
      name: 'Jane',
      phone: '555-0000',
      'q-cdl': 'Yes',
      _field_labels: '{}',
    });
    assert.equal(res.status, 200);
    assert.match(lastSmtpPayload.html_body, />Q Cdl</);
    assert.equal(lastStoredRow.field_labels, null);
  });

  test('_field_labels JSON is stripped from extras (metadata, not a customer answer)', async () => {
    // Even if a design ships _field_labels through the JSON path, it must
    // never render as an "Additional Details" row — that would leak
    // implementation detail into the operator email.
    const res = await requestJson({
      site_id: 's1',
      name: 'Jane',
      phone: '555-0000',
      'q-cdl': 'Yes',
      _field_labels: JSON.stringify({ 'q-cdl': 'Class A license?' }),
    });
    assert.equal(res.status, 200);
    // No row labelled "Field Labels" (which is what humanizeKey would produce).
    assert.doesNotMatch(lastSmtpPayload.html_body, />Field Labels</);
    // And the row IS labelled with the human question.
    assert.match(lastSmtpPayload.html_body, />Class A license\?</);
  });

  test('XSS-safe: a label with a <script> tag survives round-trip escaped', async () => {
    const res = await requestJson({
      site_id: 's1',
      name: 'Jane',
      phone: '555-0000',
      thing: 'answer',
      _field_labels: JSON.stringify({ thing: '<script>alert(1)</script>' }),
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(lastSmtpPayload.html_body, /<script>alert/);
    assert.match(lastSmtpPayload.html_body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('parseFieldLabels internal: skips non-string values, trims + caps at 200 chars', () => {
    const { parseFieldLabels } = require('../submit')._internals;
    // Reject non-strings.
    assert.deepEqual(parseFieldLabels(JSON.stringify({ a: 123, b: null, c: 'ok' })), { c: 'ok' });
    // Trim + cap.
    const long = 'x'.repeat(300);
    const out = parseFieldLabels(JSON.stringify({ q: '   ' + long + '   ' }));
    assert.equal(out.q.length, 200);
    // Malformed JSON → empty.
    assert.deepEqual(parseFieldLabels('{no'), {});
    // Non-object JSON (array / primitive) → empty.
    assert.deepEqual(parseFieldLabels('["a", "b"]'), {});
    assert.deepEqual(parseFieldLabels('42'), {});
    // Nullish / non-string input → empty.
    assert.deepEqual(parseFieldLabels(null), {});
    assert.deepEqual(parseFieldLabels(undefined), {});
    assert.deepEqual(parseFieldLabels(''), {});
    assert.deepEqual(parseFieldLabels({ a: 1 }), {});
  });
});

describe('POST /submit — multipart path (Fix A: file uploads)', () => {
  test('accepts a small PDF, forwards it as an SMTP attachment, logs metadata', async () => {
    const pdfBuf = Buffer.from('%PDF-1.4\n%fake\n');
    const res = await requestMultipart([
      { name: 'site_id', value: 's1' },
      { name: 'name', value: 'Jane Applicant' },
      { name: 'phone', value: '555-0000' },
      { name: 'email', value: 'jane@example.invalid' },
      { name: 'q-cdl', value: 'Yes' },
      {
        name: 'resume',
        filename: 'jane-doe-resume.pdf',
        contentType: 'application/pdf',
        content: pdfBuf,
      },
    ]);

    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);

    // SMTP2GO payload should now include the attachment as base64
    assert.ok(Array.isArray(lastSmtpPayload.attachments), 'attachments should be an array');
    assert.equal(lastSmtpPayload.attachments.length, 1);
    const att = lastSmtpPayload.attachments[0];
    assert.equal(att.filename, 'jane-doe-resume.pdf');
    assert.equal(att.mimetype, 'application/pdf');
    assert.equal(Buffer.from(att.fileblob, 'base64').toString('utf8'), pdfBuf.toString('utf8'));

    // Extras rendered in email should mention the attachment as a labelled row
    assert.match(lastSmtpPayload.html_body, /Resume/i);
    assert.match(lastSmtpPayload.html_body, /jane-doe-resume\.pdf/);

    // Submissions-store received the metadata (no bytes)
    assert.ok(Array.isArray(lastStoredRow.attachments));
    assert.deepEqual(lastStoredRow.attachments[0], {
      field: 'resume',
      filename: 'jane-doe-resume.pdf',
      mimetype: 'application/pdf',
      size: pdfBuf.length,
    });
  });

  test('rejects disallowed file extensions with a clear 400', async () => {
    const res = await requestMultipart([
      { name: 'site_id', value: 's1' },
      { name: 'name', value: 'Jane' },
      { name: 'phone', value: '555-0000' },
      {
        name: 'resume',
        filename: 'evil.exe',
        contentType: 'application/octet-stream',
        content: Buffer.from('MZ'),
      },
    ]);

    assert.equal(res.status, 400);
    assert.match(res.json.error, /not allowed|type/i);
    // No email sent for rejected uploads
    assert.equal(lastSmtpPayload, null);
  });

  test('rejects files that exceed the 10 MB limit', async () => {
    const bigBuf = Buffer.alloc(11 * 1024 * 1024, 0); // 11 MB
    const res = await requestMultipart([
      { name: 'site_id', value: 's1' },
      { name: 'name', value: 'Jane' },
      { name: 'phone', value: '555-0000' },
      {
        name: 'resume',
        filename: 'huge.pdf',
        contentType: 'application/pdf',
        content: bigBuf,
      },
    ]);

    assert.equal(res.status, 400);
    assert.match(res.json.error, /10 MB|exceed|limit/i);
    assert.equal(lastSmtpPayload, null);
  });

  test('rejects mismatched extension/MIME (pdf extension but wrong MIME)', async () => {
    const res = await requestMultipart([
      { name: 'site_id', value: 's1' },
      { name: 'name', value: 'Jane' },
      { name: 'phone', value: '555-0000' },
      {
        name: 'resume',
        filename: 'sneaky.pdf',
        contentType: 'application/octet-stream',
        content: Buffer.from('not really a pdf'),
      },
    ]);

    assert.equal(res.status, 400);
    assert.match(res.json.error, /mismatch/i);
  });

  test('multipart submission without any file still works (fields only)', async () => {
    // Some client scripts always POST multipart when they see any file input,
    // even if no file was actually picked. Make sure that path doesn't 400.
    const res = await requestMultipart([
      { name: 'site_id', value: 's1' },
      { name: 'name', value: 'Jane Applicant' },
      { name: 'phone', value: '555-0000' },
      { name: 'q-cdl', value: 'Yes' },
    ]);
    assert.equal(res.status, 200);
    assert.equal(lastSmtpPayload.attachments, undefined);
  });
});
