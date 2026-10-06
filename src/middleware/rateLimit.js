const rateLimit = require('express-rate-limit');

// Key by the real visitor IP, not req.ip. req.ip depends on Express's
// 'trust proxy' setting + exactly how many reverse-proxy hops sit in
// front of this service, which differs by path: the branded domain
// (forms.zingmigration.com) goes through Cloudflare *then* Railway's own
// edge proxy (2 hops), while the raw *.up.railway.app domain goes through
// just Railway's edge (1 hop) — both are live simultaneously, so a single
// fixed trust-proxy hop count can't be correct for both at once.
// Cloudflare always sets CF-Connecting-IP to the true client IP
// regardless of hop count, so prefer that when present; req.ip remains
// the fallback for the direct-Railway-domain path (where CF isn't in
// the chain at all).
//
// Found 2026-10-06 after a Ten4 (ptceevj3) customer's real contact-form
// submission got a false "Too many submissions" 429: diagnostic curl
// requests from one machine, INCLUDING ones with spoofed/distinct
// X-Forwarded-For values, all drained the exact same counter — proving
// every visitor across the entire fleet was sharing one global rate-limit
// bucket instead of being keyed per-IP.
function realIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // raised from 10 — 10 was too tight for multi-form contact pages (Ten4 had 3 dept forms)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: realIp,
  message: { error: 'Too many submissions. Please try again later.' }
});

module.exports = submissionLimiter;
