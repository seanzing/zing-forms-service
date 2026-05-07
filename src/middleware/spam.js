function checkHoneypot(req, res, next) {
  if (req.body.website && String(req.body.website).trim() !== '') {
    console.log(`[SPAM] Honeypot triggered ip=${req.ip}`);
    return res.json({ success: true, message: "Thanks! We'll be in touch soon." });
  }
  next();
}

function normalizeDudaFields(body) {
  // Duda forms use dmform-N fields with label-dmform-N companions that describe them.
  // E.g. name="dmform-0" + name="label-dmform-0" value="FIRST NAME"
  // Map label → standard field names.
  const LABEL_MAP = {
    'first name': 'first_name', 'firstname': 'first_name',
    'last name': 'last_name', 'lastname': 'last_name',
    'full name': 'full_name', 'name': 'full_name', 'your name': 'full_name',
    'email': 'email', 'email address': 'email', 'e-mail': 'email',
    'phone': 'phone', 'phone number': 'phone', 'telephone': 'phone', 'mobile': 'phone', 'cell': 'phone',
    'message': 'message', 'comments': 'message', 'comment': 'message',
    'notes': 'message', 'how can we help': 'message', 'subject': 'subject',
  };

  // Find all dmform-N keys
  const dmKeys = Object.keys(body).filter(k => /^dmform-\d+$/.test(k));
  if (dmKeys.length === 0) return; // not a Duda form

  dmKeys.forEach(key => {
    const idx = key.replace('dmform-', '');
    const label = (body[`label-${key}`] || '').toLowerCase().trim();
    const value = body[key];
    const mapped = LABEL_MAP[label];
    if (mapped && value) body[mapped] = value;
  });
}

function validateSubmission(req, res, next) {
  // Normalize Duda-style fields first
  normalizeDudaFields(req.body);

  const { site_id, email, phone } = req.body;

  // Accept multiple common name field variants
  const name =
    req.body.name ||
    req.body.full_name ||
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
