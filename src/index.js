require('dotenv').config();
const express = require('express');
const cors = require('cors');
const submitRouter = require('./routes/submit');
const healthRouter = require('./routes/health');
const adminRouter = require('./routes/admin');
const { notFoundHandler, globalErrorHandler } = require('./middleware/error-handling');

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
// Explicit limit (was relying on express's undocumented-feeling 100kb
// default). 2mb comfortably covers any real form submission (long
// message text, the renderer's _field_labels metadata blob) while still
// bounding worst-case memory per request. File uploads bypass this
// entirely — they're multipart, handled by multer in middleware/upload.js
// with its own 10MB-per-file limit, not by these JSON/urlencoded parsers.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use('/health', healthRouter);
app.use('/submit', submitRouter);
app.use('/admin', adminRouter);

// Catch-all 404 + final error handler — must be mounted LAST, in this
// order, after every real route. See middleware/error-handling.js for
// the full rationale: without these, any unmatched route or any error
// thrown outside a route's own try/catch (most importantly, a parse
// failure or oversized body inside express.json()/urlencoded() above,
// which throws BEFORE submit.js's route handler ever runs) fell through
// to Express's built-in defaults, which return an HTML error page
// instead of JSON — breaking every caller's unconditional res.json().
app.use(notFoundHandler);
app.use(globalErrorHandler);

app.listen(PORT, () => {
  console.log(`zing-forms-service running on port ${PORT}`);
});
