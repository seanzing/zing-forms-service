const express = require('express');
const router = express.Router();
const { getSites, setSite, deleteSite } = require('../services/sites');
const { listSubmissions } = require('../services/submissions-store');

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdminKey);

router.get('/sites', (req, res) => {
  res.json(getSites());
});

// List submissions for one site, newest first. Cursor-less pagination via
// ?limit=N&offset=N (limit capped at 500 in the store).
// Optional ?since=<ISO> filter for recent-only fetches.
router.get('/sites/:siteId/submissions', async (req, res) => {
  try {
    const { siteId } = req.params;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const { rows, total } = await listSubmissions(siteId, { limit, offset, since });
    res.json({ site_id: siteId, total, limit, offset, submissions: rows });
  } catch (err) {
    console.error('[ADMIN] submissions list error:', err);
    res.status(500).json({ error: 'Failed to list submissions.' });
  }
});

router.post('/sites/:siteId', (req, res) => {
  try {
    const { siteId } = req.params;
    const { businessName, ownerEmail, formTypes } = req.body;

    if (!businessName || !ownerEmail) {
      return res.status(400).json({ error: 'businessName and ownerEmail are required.' });
    }

    const siteConfig = {
      businessName,
      ownerEmail,
      formTypes: formTypes || ['contact']
    };

    setSite(siteId, siteConfig);
    res.json({ success: true, site: siteConfig });
  } catch (err) {
    console.error('[ADMIN] Error saving site:', err);
    res.status(500).json({ error: 'Failed to save site.' });
  }
});

router.patch('/sites/:siteId', (req, res) => {
  try {
    const { siteId } = req.params;
    const existing = getSiteSync ? null : null; // use getSites()
    const current = getSites()[siteId];
    if (!current) {
      return res.status(404).json({ error: 'Site not found.' });
    }
    const updated = { ...current, ...req.body };
    setSite(siteId, updated);
    res.json({ success: true, site: updated });
  } catch (err) {
    console.error('[ADMIN] Error updating site:', err);
    res.status(500).json({ error: 'Failed to update site.' });
  }
});

router.delete('/sites/:siteId', (req, res) => {
  try {
    const { siteId } = req.params;
    const deleted = deleteSite(siteId);

    if (!deleted) {
      return res.status(404).json({ error: 'Site not found.' });
    }

    res.json({ success: true, message: `Site ${siteId} deleted.` });
  } catch (err) {
    console.error('[ADMIN] Error deleting site:', err);
    res.status(500).json({ error: 'Failed to delete site.' });
  }
});

module.exports = router;
