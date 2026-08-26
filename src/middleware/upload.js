/**
 * Multipart upload middleware for POST /submit.
 *
 * Why this exists (2026-08-26, "Fix A" spec by Max):
 * The rendered inline `zing-form-handler` script serialized every form as
 * JSON, which silently dropped any <input type="file"> value (JSON.stringify
 * on a File yields `{}`). Rent A Mover's careers form has a resume upload
 * that never reached the operator. The client is now capable of sending
 * multipart/form-data when a file is picked; this middleware makes the
 * server accept it.
 *
 * Design notes:
 *   - memoryStorage: Railway containers have ephemeral disks + no shared
 *     mount. Buffer stays in RAM only long enough to hand to nodemailer as
 *     an attachment. Never touches disk.
 *   - Global limits: 10 MB per file, 5 files per submission — enough for a
 *     hi-res photo of a moving job or a resume PDF; small enough that a
 *     bad actor can't OOM the process. `req` field-count / field-size
 *     defaults from multer are already conservative.
 *   - fileFilter: allowlist by (mimetype × extension). Content sniffing is
 *     out of scope; the SMTP path treats attachments as opaque bytes and
 *     the email client + operator are the ultimate consumers. If we ever
 *     add virus scanning it lives downstream of this filter, not inside it.
 *   - Fallback: this middleware is a no-op when Content-Type is not
 *     multipart/form-data. The existing JSON path (99% of submissions on
 *     platforms without file inputs) must not regress.
 */

const multer = require('multer');
const path = require('path');

// Extension → MIME allowlist. Both must match for the file to be accepted.
// Extensions are lowercase, without the leading dot.
const ALLOWED = new Map([
  // Documents
  ['pdf', ['application/pdf']],
  ['doc', ['application/msword']],
  ['docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],

  // Images (some contact forms accept "photo of the item to be moved")
  ['jpg', ['image/jpeg']],
  ['jpeg', ['image/jpeg']],
  ['png', ['image/png']],
  ['heic', ['image/heic', 'image/heif']],
  ['heif', ['image/heif', 'image/heic']],
  ['webp', ['image/webp']],

  // Videos (some contact forms accept "video of the scope of work")
  ['mp4', ['video/mp4']],
  ['mov', ['video/quicktime']],
]);

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 5;                     // 5 files per submission

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase().replace(/^\./, '');
  const mime = (file.mimetype || '').toLowerCase();
  const allowedMimes = ALLOWED.get(ext);
  if (!allowedMimes) {
    return cb(new UploadRejection(`File type not allowed: .${ext || 'unknown'}`));
  }
  if (!allowedMimes.includes(mime)) {
    return cb(new UploadRejection(`File type mismatch: ${mime} does not match extension .${ext}`));
  }
  cb(null, true);
}

class UploadRejection extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'UploadRejection';
    this.code = 'LIMIT_UNEXPECTED_FILE'; // reuses multer's error surface so callers can branch on `err.code`
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES,
  },
  fileFilter,
});

// `.any()` accepts files under any field name — customer forms are wildly
// inconsistent (resume, photo, scope-files, upload_1…). Combined with our
// file-count limit above, this is safe.
const multipartMiddleware = upload.any();

/**
 * Route-level wrapper. Only runs multer when the request is actually
 * multipart. On any other Content-Type it calls next() immediately so the
 * existing express.json() / urlencoded parser (already mounted globally
 * in src/index.js) handles the body.
 *
 * Converts multer's errors into 400s with a stable JSON shape rather than
 * letting them bubble to the default error handler as 500s.
 */
function maybeMultipart(req, res, next) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('multipart/form-data')) return next();

  multipartMiddleware(req, res, (err) => {
    if (!err) return next();
    // Normalize error to a 400 JSON response.
    let message = err.message || 'Upload failed.';
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = `File exceeds ${MAX_FILE_BYTES / (1024 * 1024)} MB limit.`;
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      message = `Too many files (max ${MAX_FILES}).`;
    }
    console.log(`[UPLOAD] rejected code=${err.code} msg=${message}`);
    return res.status(400).json({ error: message });
  });
}

module.exports = {
  maybeMultipart,
  // Exposed for tests
  _internals: { ALLOWED, MAX_FILE_BYTES, MAX_FILES, fileFilter, UploadRejection },
};
