require('dotenv').config();
const express = require('express');
const cors = require('cors');
const submitRouter = require('./routes/submit');
const healthRouter = require('./routes/health');
const adminRouter = require('./routes/admin');
const { notFoundHandler, globalErrorHandler } = require('./middleware/error-handling');

const app = express();
const PORT = process.env.PORT || 3006;

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
