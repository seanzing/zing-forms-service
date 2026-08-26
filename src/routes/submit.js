const express = require('express');
const router = express.Router();
const rateLimit = require('../middleware/rateLimit');
const { checkHoneypot, validateSubmission } = require('../middleware/spam');
const { maybeMultipart } = require('../middleware/upload');
const { getSite } = require('../services/sites');
const { sendEmail } = require('../services/email');
const { insertSubmission } = require('../services/submissions-store');
const fs = require('fs');
const path = require('path');

// Standard-shaped submission fields the tracker/form contract exposes.
// Anything else in req.body gets shoved into `extra` for post-hoc review.
const STANDARD_FIELDS = new Set([
  'site_id', 'name', 'email', 'phone', 'message', 'form_type',
  // honeypot / anti-spam bookkeeping
  '_gotcha', '_honeypot', 'website',
]);

/**
 * Turn multer's `req.files` array into two things the downstream code needs:
 *   - `attachments`: what we hand to nodemailer / SMTP2GO (buffer + name + type)
 *   - `attachmentsMeta`: what we log to the submissions store
 *     (no bytes — just enough for the operator dashboard to say
 *      "resume.pdf (247 KB) was attached")
 *
 * Extras rendering: for each attached file we ALSO shove a human-readable
 * summary row into the `extra` bag under the same field name the browser
 * used (e.g. `resume: "my-resume.pdf (247 KB)"`), so email.js's existing
 * `renderExtras` picks it up without needing an attachment-specific code
 * path in the email template. Belt+suspenders: even if the attachment
 * fails to deliver at the SMTP layer, the operator sees WHICH file the
 * customer tried to send.
 */
function humanFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const v = bytes / Math.pow(1024, i);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function buildAttachments(reqFiles) {
  const files = Array.isArray(reqFiles) ? reqFiles : [];
  const attachments = files.map((f) => ({
    filename: f.originalname,
    content: f.buffer,
    contentType: f.mimetype,
  }));
  const attachmentsMeta = files.map((f) => ({
    field: f.fieldname,
    filename: f.originalname,
    mimetype: f.mimetype,
    size: f.size,
  }));
  const extrasSummary = {};
  for (const f of files) {
    extrasSummary[f.fieldname] = `${f.originalname} (${humanFileSize(f.size)})`;
  }
  return { attachments, attachmentsMeta, extrasSummary };
}

function extractExtras(body) {
  const extras = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (STANDARD_FIELDS.has(k)) continue;
    // cap value size defensively
    extras[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  }
  return Object.keys(extras).length ? extras : null;
}

const logsDir = path.join(__dirname, '../../logs');
const logFile = path.join(logsDir, 'submissions.jsonl');

// Detect whether this is a traditional HTML form POST (not JSON/fetch).
//
// History:
//   Pre-2026-08-26 this returned true for BOTH urlencoded and multipart.
//   That was correct back when the only way multipart hit us was from a
//   noscript <form enctype="multipart/form-data" action="/submit">.
//
//   As of Fix A (2026-08-26), Pixel's inline handler uses fetch() to POST
//   multipart bodies when a file input is present — it wants a JSON response,
//   NOT a redirect. So we now use the Accept header (fetch clients send
//   `Accept: */*` or an explicit JSON accept) and the X-Requested-With
//   fetch marker as the tiebreaker for multipart.
function isTraditionalPost(req) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/x-www-form-urlencoded')) return true;
  if (ct.includes('multipart/form-data')) {
    // Pixel's client sets neither X-Requested-With nor an application/json
    // Accept; but it ALSO doesn't send an HTML Accept for the response,
    // whereas a browser <form> submit always sends `Accept: text/html,...`.
    const accept = String(req.headers['accept'] || '').toLowerCase();
    // Only classify as traditional when the caller clearly wants an HTML
    // page back (i.e. a real <form action="/submit"> browser submit).
    return accept.includes('text/html');
  }
  return false;
}

router.post('/', rateLimit, maybeMultipart, (req, res, next) => {
  const { site_id, name, ip } = {
    site_id: req.body.site_id,
    name: req.body.name,
    ip: req.ip
  };
  const fileCount = Array.isArray(req.files) ? req.files.length : 0;
  console.log(`[SUBMIT] site_id=${site_id} ip=${ip} files=${fileCount} time=${new Date().toISOString()}`);
  next();
}, checkHoneypot, validateSubmission, async (req, res) => {
  const traditional = isTraditionalPost(req);
  try {
    const { site_id, name, email, phone, message, form_type = 'contact' } = req.body;
    // Extract once so the notification email + durable store see the
    // exact same `extra` payload. Historically only insertSubmission got
    // this; email.js rendered a fixed 4-row template, hiding every
    // form-specific field. Fixed 2026-08-20 after rentamover complaint.
    const extras = extractExtras(req.body);

    // Bundle uploaded files (if any) into email attachments + audit metadata.
    // See buildAttachments() docstring for shape rationale.
    const { attachments, attachmentsMeta, extrasSummary } = buildAttachments(req.files);
    // Merge attachment summary rows into `extras` so the operator email
    // shows "Resume: my-resume.pdf (247 KB)" alongside the other question
    // fields — no template changes needed in email.js.
    let extrasForEmail = extras;
    if (attachments.length > 0) {
      extrasForEmail = { ...(extras || {}), ...extrasSummary };
    }

    const site = await getSite(site_id);
    if (!site) {
      console.log(`[SUBMIT] result=not_found site_id=${site_id}`);
      return res.status(404).json({ error: 'Unknown site.' });
    }

    // If no owner email configured, log and accept silently — don't send to a wrong address
    if (!site.ownerEmail) {
      console.log(`[SUBMIT] result=no_owner_email site_id=${site_id} — submission logged only`);
      try {
        fs.appendFileSync(logFile, JSON.stringify({
          timestamp: new Date().toISOString(),
          site_id, name, phone: phone || null, email: email || null,
          form_type, ip: req.ip, emailSent: false, reason: 'no_owner_email'
        }) + '\n');
      } catch (_) {}
      return res.json({ success: true, message: "Thanks! We'll be in touch soon." });
    }

    // sendEmail now returns { sent, error, attempts } after 2026-08-19
    // reliability rewrite (30s timeout + retry-on-transient). See
    // services/email.js header.
    let emailSent = false;
    let emailError = null;
    let emailAttempts = 0;
    try {
      const result = await sendEmail({
        site,
        site_id,
        name,
        email,
        phone,
        message,
        form_type,
        extra: extrasForEmail,
        attachments,
      });
      emailSent = result.sent;
      emailError = result.error;
      emailAttempts = result.attempts;
      if (emailAttempts > 1) {
        console.log(`[SUBMIT] email required ${emailAttempts} attempt(s) site_id=${site_id} sent=${emailSent}`);
      }
    } catch (err) {
      emailError = (err && err.message) || String(err);
      console.error('[SUBMIT] sendEmail threw:', emailError);
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      site_id,
      name,
      phone: phone || null,
      email: email || null,
      form_type,
      ip: req.ip,
      emailSent
    };

    try {
      fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    } catch (err) {
      console.error('[LOG] Failed to write submission log:', err.message);
    }

    // Durable persistence to Pixel Supabase. Non-fatal — the visitor still
    // sees success even if the store is unavailable (email + local log are
    // the primary delivery paths). See services/submissions-store.js.
    insertSubmission({
      site_id,
      form_type,
      name,
      email,
      phone,
      message,
      extra: extras,
      attachments: attachmentsMeta.length ? attachmentsMeta : null,
      email_sent: emailSent,
      email_error: emailError,
      ip: req.ip,
      user_agent: req.headers['user-agent'] || null,
    }).catch((err) => console.error('[SUBMIT] insertSubmission failed:', err.message));

    if (!emailSent) {
      console.log(`[SUBMIT] result=email_failed site_id=${site_id}`);
      if (traditional) {
        const ref = req.headers.referer || '/';
        return res.redirect(`${ref}${ref.includes('?') ? '&' : '?'}form=error`);
      }
      return res.status(500).json({ error: "Failed to send message. Please try calling us directly." });
    }

    console.log(`[SUBMIT] result=success site_id=${site_id}`);
    if (traditional) {
      const ref = req.headers.referer || '/';
      return res.redirect(`${ref}${ref.includes('?') ? '&' : '?'}form=sent`);
    }
    res.json({ success: true, message: "Thanks! We'll be in touch soon." });
  } catch (err) {
    console.error('[SUBMIT] Unexpected error:', err);
    if (isTraditionalPost(req)) {
      const ref = req.headers.referer || '/';
      return res.redirect(`${ref}${ref.includes('?') ? '&' : '?'}form=error`);
    }
    res.status(500).json({ error: "Failed to send message. Please try calling us directly." });
  }
});

module.exports = router;
