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

// Case-insensitive alias map: any incoming field key whose lowercased+trimmed
// (whitespace-collapsed) form matches an entry below is mirrored onto the
// canonical key IF that canonical isn't already set on req.body.
//
// This handles human-labeled forms like:
//   { "Full name": "Alice", "Email": "a@b.com", "Phone": "555" }
// which used to slip past the resolver and 400 with "name is required."
// (Real repro: axce8w7k / Naples Tennis.)
const HUMAN_LABEL_ALIASES = {
  // name variants → name
  'name': 'name',
  'full name': 'name',
  'fullname': 'name',
  'your name': 'name',
  'yourname': 'name',
  // first / last
  'first name': 'first_name',
  'firstname': 'first_name',
  'last name': 'last_name',
  'lastname': 'last_name',
  // email
  'email': 'email',
  'email address': 'email',
  'emailaddress': 'email',
  'e-mail': 'email',
  'e mail': 'email',
  // phone
  'phone': 'phone',
  'phone number': 'phone',
  'phonenumber': 'phone',
  'telephone': 'phone',
  'mobile': 'phone',
  'mobile number': 'phone',
  'cell': 'phone',
  'cell phone': 'phone',
  // message
  'message': 'message',
  'comments': 'message',
  'comment': 'message',
  'notes': 'message',
  'how can we help': 'message',
  'how can we help you': 'message',
  // subject
  'subject': 'subject',
};

function normalizeHumanLabels(body) {
  // Build a lookup of lowercased key → original key so we can mirror without
  // clobbering. Iterate the body keys once.
  for (const key of Object.keys(body)) {
    if (typeof key !== 'string') continue;
    // Collapse internal whitespace and lowercase, but keep spaces so
    // "Full  Name" and "Full name" both resolve.
    const norm = key.toLowerCase().trim().replace(/\s+/g, ' ');
    const canonical = HUMAN_LABEL_ALIASES[norm];
    if (!canonical) continue;
    // Don't overwrite an already-set canonical value. Predictable precedence:
    // whichever key literally matches the canonical wins.
    if (key === canonical) continue;
    if (body[canonical] !== undefined && body[canonical] !== null && String(body[canonical]).trim() !== '') continue;
    const value = body[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    body[canonical] = value;
  }
}

function validateSubmission(req, res, next) {
  // Normalize Duda-style fields first
  normalizeDudaFields(req.body);

  // Then mirror case-insensitive human labels (Full name, Email, Phone, etc.)
  // onto canonical keys.
  normalizeHumanLabels(req.body);

  const { site_id, email, phone } = req.body;

  // Accept multiple common name field variants
  const name =
    req.body.name ||
    req.body.full_name ||
    req.body.fullName ||
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
