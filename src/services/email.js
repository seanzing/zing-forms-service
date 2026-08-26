const axios = require('axios');

/**
 * Send a form submission notification email via SMTP2GO with automatic
 * retry on transient failures.
 *
 * Reliability history (see 2026-08-19 audit):
 *   - Original impl: single attempt, 10s timeout, boolean return.
 *   - Observed: intermittent 10s+ timeouts from Railway → SMTP2GO. On a
 *     small-volume site (~2-3 submits/month), a single transient failure
 *     = an entire lost lead. Not acceptable when a customer is paying
 *     for the site.
 *
 * New behaviour:
 *   - 30s per-attempt timeout (SMTP2GO API is usually <2s; the extra
 *     headroom absorbs Railway network jitter without harming happy path).
 *   - 3 total attempts with backoff: 0s / 2s / 6s.
 *   - Retryable = network errors, 5xx, 429 rate limits, timeouts.
 *     NOT retryable = 4xx (bad payload — retrying won't help).
 *   - Returns `{ sent: boolean, error: string | null, attempts: number }`
 *     so the caller can persist the exact failure reason.
 */
const SEND_TIMEOUT_MS = Number(process.env.EMAIL_SEND_TIMEOUT_MS) || 30_000;
// Retry delays override via EMAIL_RETRY_DELAYS_MS (comma-separated, ms) so
// tests can drive the retry ladder without sleeping 8 seconds.
function parseRetryDelays() {
  const raw = process.env.EMAIL_RETRY_DELAYS_MS;
  if (!raw) return [0, 2_000, 6_000];
  const parts = raw.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n >= 0);
  return parts.length ? parts : [0, 2_000, 6_000];
}
const RETRY_DELAYS_MS = parseRetryDelays();

async function sleep(ms) {
  if (ms <= 0) return;
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err) {
  // Network / timeout / connection reset
  if (!err.response) return true;
  const status = err.response.status || 0;
  // Retry 5xx and 429; do not retry other 4xx (that's a real rejection).
  if (status >= 500 || status === 429) return true;
  return false;
}

async function sendEmail({ site, site_id, name, email, phone, message, form_type, extra, fieldLabels, attachments }) {
  const apiKey = process.env.SMTP2GO_API_KEY;
  const fromEmail = process.env.SMTP2GO_FROM_EMAIL || 'noreply@zing-work.com';
  const fromName = process.env.SMTP2GO_FROM_NAME || 'ZING Website Forms';

  const subject = `New ${form_type} from ${name} — ${site.businessName}`;
  const timestamp = new Date().toISOString();

  // Fix B (2026-08-26): the renderer may have emitted a
  // { fieldName -> human question text } map alongside the submission.
  // When present, `renderExtras` prefers `labels[key]` over
  // `humanizeKey(key)` so the operator sees “Do you have a Class A
  // license?” instead of “Q Cdl”. Falls through to humanizeKey() for
  // every field the map doesn't cover — no regression for existing
  // designs that don’t ship labels yet.
  const extrasHtml = renderExtras(extra, fieldLabels);

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333; border-bottom: 2px solid #0066cc; padding-bottom: 10px;">
        New ${form_type} submission
      </h2>
      <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
        <tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555; width: 140px;">Name</td>
          <td style="padding: 8px 12px;">${escapeHtml(name)}</td>
        </tr>
        ${email ? `<tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555;">Email</td>
          <td style="padding: 8px 12px;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td>
        </tr>` : ''}
        ${phone ? `<tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555;">Phone</td>
          <td style="padding: 8px 12px;"><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></td>
        </tr>` : ''}
        ${message ? `<tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555; vertical-align: top;">Message</td>
          <td style="padding: 8px 12px; white-space: pre-wrap;">${escapeHtml(message)}</td>
        </tr>` : ''}
        ${extrasHtml}
      </table>
      <p style="margin-top: 24px; font-size: 12px; color: #999;">
        Submitted at ${timestamp}<br>
        Site: ${escapeHtml(site_id)} (${escapeHtml(site.businessName)})
      </p>
    </div>
  `;

  // SMTP2GO's `to:` field parses the entry as an RFC 5322 mailbox.
  // 'Display Name <email>' is valid in theory, but a display name with a
  // comma (e.g. 'You Mess Up, We Clean Up') gets split on the comma and
  // treated as multiple recipients → 400 "no angle-addr". Diagnosed
  // 2026-06-29 (site lkv363od). Ship the bare email; the businessName is
  // in the subject + html body.
  const payload = {
    api_key: apiKey,
    to: [site.ownerEmail],
    sender: `${fromName} <${fromEmail}>`,
    subject,
    html_body: htmlBody,
  };

  if (email) {
    payload.custom_headers = [{ header: 'Reply-To', value: email }];
  }

  // File attachments (added 2026-08-26 for Fix A). SMTP2GO's v3 API takes
  // attachments as base64 strings under the `attachments` field. Each item:
  //   { filename, fileblob (base64), mimetype }
  // We only support Buffer content in-process today — nodemailer-shaped
  // { filename, content, contentType } objects come in from submit.js and
  // are converted here so the two paths (SMTP2GO now / nodemailer someday)
  // stay decoupled.
  if (Array.isArray(attachments) && attachments.length > 0) {
    payload.attachments = attachments.map((a) => ({
      filename: a.filename,
      fileblob: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content || ''),
      mimetype: a.contentType || 'application/octet-stream',
    }));
  }

  let lastError = null;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      console.log(`[EMAIL] retry attempt ${attempt + 1}/${RETRY_DELAYS_MS.length} for site_id=${site_id}`);
    }
    try {
      const response = await axios.post(
        'https://api.smtp2go.com/v3/email/send',
        payload,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: SEND_TIMEOUT_MS,
        },
      );

      if (response.data && response.data.data && response.data.data.succeeded > 0) {
        return { sent: true, error: null, attempts: attempt + 1 };
      }

      // SMTP2GO returned 200 but succeeded=0 — inspect the response for
      // recipient-level failure details.
      const failureReason =
        response.data?.data?.failures?.[0] ||
        response.data?.data?.error ||
        'SMTP2GO returned 200 but did not confirm success';
      console.error(`[EMAIL] non-success on attempt ${attempt + 1}:`, JSON.stringify(response.data).slice(0, 400));
      lastError = String(failureReason).slice(0, 500);
      // Non-success at API level is a real rejection (e.g. blocklisted
      // recipient). Don't retry.
      return { sent: false, error: lastError, attempts: attempt + 1 };
    } catch (err) {
      lastError =
        err.response?.data?.data?.error ||
        err.response?.data?.error ||
        err.message ||
        String(err);
      lastError = String(lastError).slice(0, 500);
      console.error(`[EMAIL] attempt ${attempt + 1} error:`, lastError);
      if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length - 1) {
        return { sent: false, error: lastError, attempts: attempt + 1 };
      }
      // else: fall through, next iteration retries after the backoff delay
    }
  }

  return { sent: false, error: lastError || 'exhausted retries', attempts: RETRY_DELAYS_MS.length };
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turn a raw field key (snake_case, kebab-case, or camelCase) into a
 * human-friendly Title-Case label. Examples:
 *   movetype        -> "Movetype"
 *   move_type       -> "Move Type"
 *   from-residence  -> "From Residence"
 *   timingNotes     -> "Timing Notes"
 */
function humanizeKey(key) {
  if (!key) return '';
  const str = String(key)
    // insert space at camelCase word boundaries: fooBar -> foo Bar
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // split snake_case / kebab-case
    .replace(/[_-]+/g, ' ')
    .trim();
  return str
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/**
 * Format a single field value for HTML display. Returns null when the
 * value should be skipped entirely (empty string, null, undefined, empty
 * object, empty array).
 */
function formatValueHtml(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return escapeHtml(String(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // white-space:pre-wrap on the containing cell handles multiline
    return escapeHtml(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return escapeHtml(value.map((v) => (v === null || v === undefined ? '' : String(v))).join(', '));
  }
  if (typeof value === 'object') {
    // Skip empty objects (e.g. the file-upload placeholder `scope: {}`).
    if (Object.keys(value).length === 0) return null;
    return `<pre style="margin: 0; font-family: Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap;">${escapeHtml(
      JSON.stringify(value, null, 2),
    )}</pre>`;
  }
  // fallback: coerce to string
  const s = String(value);
  return s ? escapeHtml(s) : null;
}

/**
 * Render every non-empty entry in `extra` as an appended table row block,
 * preceded by a subtle "Additional Details" section header. Returns an
 * empty string when there is nothing worth showing.
 *
 * Ordering: preserve insertion order of the extra object so the operator
 * sees fields in roughly the same sequence the customer filled them out.
 *
 * @param {object} extra
 *   The extras bag pulled off the submission body (unknown fields the
 *   form contract doesn’t explicitly know about).
 * @param {object} [labels]
 *   Optional { fieldName -> human question text } map, provided by the
 *   Pixel renderer via a hidden `_field_labels` input. Fix B (2026-08-26).
 *   When a key exists in this map, we use the label verbatim; otherwise
 *   we fall back to `humanizeKey(key)` — same behaviour as pre-Fix-B.
 */
function renderExtras(extra, labels) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return '';
  const labelMap = labels && typeof labels === 'object' && !Array.isArray(labels) ? labels : {};
  const rows = [];
  for (const [key, value] of Object.entries(extra)) {
    const html = formatValueHtml(value);
    if (html === null) continue;
    // Prefer renderer-provided label. Only strings count — anything else
    // (accidental object, boolean, etc.) falls through to humanizeKey().
    const rawLabel = typeof labelMap[key] === 'string' ? labelMap[key].trim() : '';
    const label = rawLabel || humanizeKey(key);
    rows.push(`<tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555; vertical-align: top;">${escapeHtml(
            label,
          )}</td>
          <td style="padding: 8px 12px; white-space: pre-wrap;">${html}</td>
        </tr>`);
  }
  if (rows.length === 0) return '';
  const header = `<tr>
          <td colspan="2" style="padding: 12px 12px 6px; margin-top: 8px; font-weight: bold; color: #333; background: #f4f6f8; border-top: 1px solid #e2e6ea; border-bottom: 1px solid #e2e6ea; text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px;">Additional Details</td>
        </tr>`;
  return header + rows.join('');
}

module.exports = { sendEmail, _internals: { humanizeKey, formatValueHtml, renderExtras } };
