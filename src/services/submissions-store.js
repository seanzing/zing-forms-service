/**
 * Durable submissions store.
 *
 * Writes every accepted form submission to Pixel's Supabase `form_submissions`
 * table. Falls back silently to the existing local jsonl if Supabase is
 * unavailable (submit path stays green even if the store is down).
 *
 * Env:
 *   PIXEL_SUPABASE_URL         — https://ohieyclfacdznghbyrpi.supabase.co
 *   PIXEL_SUPABASE_SERVICE_KEY — service role JWT for writes
 *                                (accepts PIXEL_SUPABASE_SERVICE_ROLE_KEY as an alias)
 *
 * Read path exposed via /admin/sites/:siteId/submissions in src/routes/admin.js.
 * The forms service is the only writer of this table (Pixel reads via a
 * proxy route so it can trust admin-key gating).
 */

const crypto = require('crypto');

let _client = null;
function getClient() {
  if (_client) return _client;
  const url = process.env.PIXEL_SUPABASE_URL;
  const key = process.env.PIXEL_SUPABASE_SERVICE_KEY || process.env.PIXEL_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

function hashIp(ip, salt) {
  if (!ip) return null;
  const h = crypto.createHash('sha256');
  h.update(String(salt || 'zing-forms-service') + '::' + String(ip));
  return h.digest('hex').slice(0, 24);
}

/**
 * Record a submission. Non-fatal — logs on failure and returns null so the
 * calling submit handler keeps returning success to the site visitor.
 *
 * @param {object} row
 * @param {string} row.site_id
 * @param {string} row.form_type
 * @param {string|null} row.name
 * @param {string|null} row.email
 * @param {string|null} row.phone
 * @param {string|null} row.message
 * @param {object|null} row.extra
 * @param {boolean} row.email_sent
 * @param {string|null} row.email_error
 * @param {string|null} row.ip
 * @param {string|null} row.user_agent
 * @returns {Promise<{id:string}|null>}
 */
async function insertSubmission(row) {
  const client = getClient();
  if (!client) {
    console.warn('[submissions-store] Supabase not configured — skipping durable write');
    return null;
  }
  try {
    const { data, error } = await client
      .from('form_submissions')
      .insert({
        site_id: row.site_id,
        form_type: row.form_type || 'contact',
        name: row.name || null,
        email: row.email || null,
        phone: row.phone || null,
        message: row.message || null,
        extra: row.extra || null,
        email_sent: !!row.email_sent,
        email_error: row.email_error || null,
        ip_hash: hashIp(row.ip, process.env.IP_HASH_SALT),
        user_agent: (row.user_agent || '').slice(0, 400) || null,
      })
      .select('id')
      .single();
    if (error) {
      console.error('[submissions-store] insert error:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[submissions-store] insert threw:', err.message);
    return null;
  }
}

/**
 * List submissions for a site, newest first.
 * @param {string} siteId
 * @param {object} opts
 * @param {number} [opts.limit=50] max rows to return (capped at 500)
 * @param {number} [opts.offset=0] pagination offset
 * @param {string} [opts.since] ISO timestamp — only rows submitted_at >= since
 */
async function listSubmissions(siteId, opts = {}) {
  const client = getClient();
  if (!client) return { rows: [], total: 0 };
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  let q = client
    .from('form_submissions')
    .select(
      'id,site_id,form_type,submitted_at,name,email,phone,message,extra,email_sent,email_error',
      { count: 'exact' },
    )
    .eq('site_id', siteId)
    .order('submitted_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (opts.since) q = q.gte('submitted_at', opts.since);
  const { data, error, count } = await q;
  if (error) {
    console.error('[submissions-store] list error:', error.message);
    return { rows: [], total: 0 };
  }
  return { rows: data || [], total: count || 0 };
}

module.exports = { insertSubmission, listSubmissions };
