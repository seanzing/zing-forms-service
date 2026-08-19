const express = require('express');
const router = express.Router();
const rateLimit = require('../middleware/rateLimit');
const { checkHoneypot, validateSubmission } = require('../middleware/spam');
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

// Detect whether this is a traditional HTML form POST (not JSON/fetch)
function isTraditionalPost(req) {
  const ct = req.headers['content-type'] || '';
  return ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data');
}

router.post('/', rateLimit, (req, res, next) => {
  const { site_id, name, ip } = {
    site_id: req.body.site_id,
    name: req.body.name,
    ip: req.ip
  };
  console.log(`[SUBMIT] site_id=${site_id} ip=${ip} time=${new Date().toISOString()}`);
  next();
}, checkHoneypot, validateSubmission, async (req, res) => {
  const traditional = isTraditionalPost(req);
  try {
    const { site_id, name, email, phone, message, form_type = 'contact' } = req.body;

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

    let emailSent = false;
    let emailError = null;
    try {
      emailSent = await sendEmail({
        site,
        site_id,
        name,
        email,
        phone,
        message,
        form_type
      });
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
      extra: extractExtras(req.body),
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
