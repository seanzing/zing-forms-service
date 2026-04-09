const express = require('express');
const router = express.Router();
const { getSites, setSite, deleteSite } = require('../services/sites');

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
