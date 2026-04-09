const express = require('express');
const router = express.Router();
const { getSites } = require('../services/sites');

router.get('/', (req, res) => {
  const sites = getSites();
  res.json({
    status: 'ok',
    sites: Object.keys(sites).length,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
