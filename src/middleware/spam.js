function checkHoneypot(req, res, next) {
  if (req.body.website && String(req.body.website).trim() !== '') {
    console.log(`[SPAM] Honeypot triggered ip=${req.ip}`);
    return res.json({ success: true, message: "Thanks! We'll be in touch soon." });
  }
  next();
}

function validateSubmission(req, res, next) {
  const { site_id, email, phone } = req.body;

  // Accept multiple common name field variants
  const name =
    req.body.name ||
    req.body.fullName ||
    req.body.full_name ||
    req.body.your_name ||
    (req.body.first_name
      ? [req.body.first_name, req.body.last_name].filter(Boolean).join(' ')
      : null);

  // Normalise onto req.body.name so downstream handlers always see it
  if (name) req.body.name = String(name).trim();

  if (!site_id) {
    return res.status(400).json({ error: 'site_id is required.' });
  }

  if (!req.body.name || req.body.name === '') {
    return res.status(400).json({ error: 'name is required.' });
  }

  if ((!email || String(email).trim() === '') && (!phone || String(phone).trim() === '')) {
    return res.status(400).json({ error: 'At least one of email or phone is required.' });
  }

  next();
}

module.exports = { checkHoneypot, validateSubmission };
