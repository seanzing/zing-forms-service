/**
 * Global fallback handlers — catch-all 404 and final error handler.
 *
 * Why this exists (2026-10-02):
 * src/index.js had neither of these registered. Express's BUILT-IN
 * defaults for both cases return a plain HTML page
 * (`<!DOCTYPE html>...<title>Error</title>...`), never JSON — but every
 * real caller of this service (the inline zing-form-handler script
 * baked into every Pixel site, see lib/inject-form-handler.ts in
 * zing-pixel-dashboard) does `res.json()` unconditionally on the
 * response with no try/catch. Any request that reached this service
 * and fell through to one of Express's defaults threw a client-side
 * `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid
 * JSON` with zero indication of what actually went wrong.
 *
 * Concretely, before this fix, the defaults fired on:
 *   - Any unmatched path (typo, stale client pointing at an old route,
 *     a future route rename) → Express's built-in 404 handler.
 *   - A malformed JSON body on POST /submit — express.json() throws a
 *     SyntaxError synchronously in its own middleware, which happens
 *     BEFORE submit.js's route handler (and its try/catch) ever runs.
 *   - A JSON or urlencoded body over the default 100kb limit (a long
 *     customer message, a big `_field_labels` blob, etc.) — same
 *     express.json()/urlencoded() throw-before-the-route-handler shape,
 *     surfaced as a PayloadTooLargeError.
 *   - Any future route or middleware added later that throws without
 *     its own try/catch (defense in depth — this is the safety net the
 *     rest of the app should never need, but must exist).
 *
 * Both handlers below always respond with a JSON body and a stable
 * `{ error: string }` shape, matching every other error response this
 * service already returns (see submit.js, upload.js, rateLimit.js) so
 * every client-side `.json()` call succeeds and `err.body.error` is
 * always a readable string.
 */

/** Mount AFTER every real route (`/health`, `/submit`, `/admin`). */
function notFoundHandler(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

/**
 * Mount LAST, after notFoundHandler. Express only treats a middleware as
 * an error handler when it declares exactly 4 params (err, req, res, next)
 * — do not refactor this to 3 params, Express's dispatcher inspects
 * `fn.length` to decide.
 *
 * Handles both synchronous throws inside route handlers (e.g. JSON parse
 * failures in express.json(), which fire before any route code runs) and
 * errors explicitly passed via `next(err)`.
 */
// eslint-disable-next-line no-unused-vars
function globalErrorHandler(err, req, res, next) {
  const status = Number.isInteger(err?.status) ? err.status
    : Number.isInteger(err?.statusCode) ? err.statusCode
    : 500;

  // body-parser (used internally by express.json()/urlencoded()) sets
  // err.type for its own failure modes. Give these a clearer message
  // than the raw SyntaxError/PayloadTooLargeError text, which can leak
  // parser internals and isn't actionable for a form-submitter anyway.
  let message = err?.message || 'Internal server error.';
  if (err?.type === 'entity.parse.failed') {
    message = 'Malformed request body.';
  } else if (err?.type === 'entity.too.large') {
    message = 'Request body too large.';
  }

  if (status >= 500) {
    console.error('[GLOBAL ERROR]', err);
  } else {
    console.log(`[GLOBAL ERROR] status=${status} message=${message}`);
  }

  res.status(status).json({ error: message });
}

module.exports = { notFoundHandler, globalErrorHandler };
