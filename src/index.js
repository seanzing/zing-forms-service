require('dotenv').config();
const express = require('express');
const cors = require('cors');
const submitRouter = require('./routes/submit');
const healthRouter = require('./routes/health');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3006;

// Required for express-rate-limit (and req.ip generally) to see the real
// visitor IP instead of Railway's own reverse-proxy address. Without this,
// Express ignores X-Forwarded-For entirely and req.ip resolves to the
// proxy's socket peer for EVERY request — meaning the /submit rate limiter
// (10 req / 15 min, see middleware/rateLimit.js) was keyed on a single
// shared bucket for the ENTIRE service, across every site and every real
// visitor, not per-visitor as intended. Confirmed 2026-10-06: spoofing
// different X-Forwarded-For values had zero effect on the limiter's
// remaining-count header, and 5 plain sequential curl requests from one
// machine was enough to trip a 429 for a real Ten4 contact-form submitter
// on an unrelated session. `1` trusts exactly one hop (Railway's edge
// proxy), which matches Railway's network topology.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/health', healthRouter);
app.use('/submit', submitRouter);
app.use('/admin', adminRouter);

app.listen(PORT, () => {
  console.log(`zing-forms-service running on port ${PORT}`);
});
