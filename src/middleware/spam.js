function checkHoneypot(req, res, next) {
  if (req.body.website && String(req.body.website).trim() !== '') {
    console.log(`[SPAM] Honeypot triggered ip=${req.ip}`);
    return res.json({ success: true, message: "Thanks! We'll be in touch soon." });
  }
  next();
}

function validateSubmission(req, res, next) {
  const { site_id, name, email, phone } = req.body;

  if (!site_id) {
    return res.status(400).json({ error: 'site_id is required.' });
  }

  if (!name || String(name).trim() === '') {
    return res.status(400).json({ error: 'name is required.' });
  }

  if ((!email || String(email).trim() === '') && (!phone || String(phone).trim() === '')) {
    return res.status(400).json({ error: 'At least one of email or phone is required.' });
  }

  next();
}

module.exports = { checkHoneypot, validateSubmission };
