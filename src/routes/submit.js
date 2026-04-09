const express = require('express');
const router = express.Router();
const rateLimit = require('../middleware/rateLimit');
const { checkHoneypot, validateSubmission } = require('../middleware/spam');
const { getSite } = require('../services/sites');
const { sendEmail } = require('../services/email');
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../../logs');
const logFile = path.join(logsDir, 'submissions.jsonl');

router.post('/', rateLimit, (req, res, next) => {
  const { site_id, name, ip } = {
    site_id: req.body.site_id,
    name: req.body.name,
    ip: req.ip
  };
  console.log(`[SUBMIT] site_id=${site_id} ip=${ip} time=${new Date().toISOString()}`);
  next();
}, checkHoneypot, validateSubmission, async (req, res) => {
  try {
    const { site_id, name, email, phone, message, form_type = 'contact' } = req.body;

    const site = getSite(site_id);
    if (!site) {
      console.log(`[SUBMIT] result=not_found site_id=${site_id}`);
      return res.status(404).json({ error: 'Unknown site.' });
    }

    const emailSent = await sendEmail({
      site,
      site_id,
      name,
      email,
      phone,
      message,
      form_type
    });

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

    if (!emailSent) {
      console.log(`[SUBMIT] result=email_failed site_id=${site_id}`);
      return res.status(500).json({ error: "Failed to send message. Please try calling us directly." });
    }

    console.log(`[SUBMIT] result=success site_id=${site_id}`);
    res.json({ success: true, message: "Thanks! We'll be in touch soon." });
  } catch (err) {
    console.error('[SUBMIT] Unexpected error:', err);
    res.status(500).json({ error: "Failed to send message. Please try calling us directly." });
  }
});

module.exports = router;
