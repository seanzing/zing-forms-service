/**
 * sites.js — Site configuration service
 *
 * Primary source: Pixel Supabase `sites` table (owner_email, business_name).
 * Fallback: in-memory map populated via admin API (backwards-compatible).
 *
 * This means zero manual registration is needed — any site imported into Pixel
 * automatically works with the forms service.
 */

const fs = require('fs');
const path = require('path');

// ── Supabase client ──────────────────────────────────────────────

let supabase = null;

function getSupabaseClient() {
  if (supabase) return supabase;
  const url = process.env.PIXEL_SUPABASE_URL;
  const key = process.env.PIXEL_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key);
    console.log('[SITES] Supabase client initialised');
    return supabase;
  } catch (err) {
    console.warn('[SITES] Failed to init Supabase client:', err.message);
    return null;
  }
}

// ── In-memory cache (TTL = 5 min) ───────────────────────────────

const cache = new Map(); // siteId → { config, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(siteId) {
  const entry = cache.get(siteId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(siteId); return null; }
  return entry.config;
}

function cacheSet(siteId, config) {
  cache.set(siteId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Legacy JSON fallback ─────────────────────────────────────────
// Still loaded so admin-registered sites (e.g. mooreroofing) keep working.

const sitesPath = path.join(__dirname, '../../data/sites.json');
let legacySites = {};

function loadLegacy() {
  try {
    const raw = fs.readFileSync(sitesPath, 'utf8');
    legacySites = JSON.parse(raw);
    console.log(`[SITES] Loaded ${Object.keys(legacySites).length} legacy site(s) from sites.json`);
  } catch {
    legacySites = {};
  }
}

function saveLegacy() {
  try {
    fs.mkdirSync(path.dirname(sitesPath), { recursive: true });
    fs.writeFileSync(sitesPath, JSON.stringify(legacySites, null, 2) + '\n');
  } catch (err) {
    console.warn('[SITES] Could not persist sites.json:', err.message);
  }
}

loadLegacy();

// ── Public API ───────────────────────────────────────────────────

/**
 * Look up a site config. Checks (in order):
 *   1. In-memory cache
 *   2. Supabase `sites` table (if configured)
 *   3. Legacy sites.json
 */
async function getSite(siteId) {
  if (!siteId) return null;

  // 1. Cache
  const cached = cacheGet(siteId);
  if (cached) return cached;

  // 2. Supabase
  const sb = getSupabaseClient();
  if (sb) {
    try {
      const { data, error } = await sb
        .from('sites')
        .select('id, business_name, owner_email, form_recipients')
        .eq('id', siteId)
        .maybeSingle();

      if (!error && data && data.owner_email) {
        const config = {
          businessName: data.business_name || siteId,
          ownerEmail: data.owner_email,
          // form_recipients is a jsonb column, {} by default (added
          // 2026-09-15, see supabase/migrations/20260915160000_sites_form_recipients.sql
          // in zing-pixel-dashboard). Maps a form_type (e.g. "sales",
          // "careers") to a distinct recipient email for that form's
          // submissions — resolveRecipient() below falls back to
          // ownerEmail for any form_type not present in this map, which
          // is every form_type on every site until an operator sets one
          // via the Pixel dashboard's "Form Recipients" section.
          formRecipients: (data.form_recipients && typeof data.form_recipients === 'object') ? data.form_recipients : {},
          formTypes: ['contact'],
          source: 'supabase',
        };
        cacheSet(siteId, config);
        return config;
      }
    } catch (err) {
      console.warn(`[SITES] Supabase lookup failed for ${siteId}:`, err.message);
    }
  }

  // 3. Legacy JSON
  if (legacySites[siteId]) {
    const config = { ...legacySites[siteId], source: 'legacy' };
    cacheSet(siteId, config);
    return config;
  }

  return null;
}

/**
 * Resolve the email address(es) a submission for `formType` should go to.
 * Prefers site.formRecipients[formType] (per-form override); falls back
 * to site.ownerEmail when formType isn't set, formRecipients is missing
 * entirely (legacy sites.json entries, or Supabase rows predating the
 * form_recipients column), or the mapped value is empty/falsy.
 *
 * Supports multiple recipients for a single form_type: store a
 * comma-separated list in the same string field (e.g.
 * "sales@x.com, manager@x.com") — no schema change needed. Returns an
 * array of trimmed, non-empty email addresses (always at least one
 * entry when a recipient exists, empty array when none does).
 */
function resolveRecipients(site, formType) {
  const recipients = site && typeof site.formRecipients === 'object' ? site.formRecipients : null;
  const key = formType || 'contact';
  const raw = (recipients && recipients[key]) || (site ? site.ownerEmail : null);
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

/** @deprecated use resolveRecipients — kept for any external callers/tests during migration. */
function resolveRecipient(site, formType) {
  const all = resolveRecipients(site, formType);
  return all.length ? all[0] : null;
}

/** Synchronous getSite for places that can't await (returns legacy only). */
function getSiteSync(siteId) {
  const cached = cacheGet(siteId);
  if (cached) return cached;
  return legacySites[siteId] || null;
}

function getSites() {
  return legacySites;
}

/** Register/update a site in the legacy store (admin API). */
function setSite(siteId, config) {
  legacySites[siteId] = config;
  cacheSet(siteId, config);
  saveLegacy();
}

function deleteSite(siteId) {
  if (!legacySites[siteId]) return false;
  delete legacySites[siteId];
  cache.delete(siteId);
  saveLegacy();
  return true;
}

module.exports = { getSite, getSiteSync, getSites, setSite, deleteSite, resolveRecipient, resolveRecipients };
