const fs = require('fs');
const path = require('path');

const sitesPath = path.join(__dirname, '../../data/sites.json');
let sites = {};

function loadSites() {
  try {
    const raw = fs.readFileSync(sitesPath, 'utf8');
    sites = JSON.parse(raw);
    console.log(`[SITES] Loaded ${Object.keys(sites).length} site(s)`);
  } catch (err) {
    console.warn('[SITES] Warning: Could not load sites.json —', err.message);
    sites = {};
  }
}

function saveSites() {
  fs.writeFileSync(sitesPath, JSON.stringify(sites, null, 2) + '\n');
}

function getSites() {
  return sites;
}

function getSite(siteId) {
  return sites[siteId] || null;
}

function setSite(siteId, config) {
  sites[siteId] = config;
  saveSites();
}

function deleteSite(siteId) {
  if (!sites[siteId]) return false;
  delete sites[siteId];
  saveSites();
  return true;
}

loadSites();

module.exports = { getSites, getSite, setSite, deleteSite };
