/**
 * Tests for src/services/sites.js's resolveRecipient() — per-form
 * recipient routing (2026-09-15).
 *
 * See supabase/migrations/20260915160000_sites_form_recipients.sql in
 * zing-pixel-dashboard for the column this reads. `getSite()`'s Supabase
 * path is not exercised here (no live Supabase client in test env) — this
 * file tests resolveRecipient() directly against hand-built site objects,
 * covering exactly the shapes getSite() can produce: formRecipients as a
 * real object with a matching/missing key, formRecipients absent entirely
 * (legacy sites.json rows), and formRecipients present but empty ({}, the
 * default for every site until an operator sets one).
 *
 * Run: node --test src/services/__tests__/sites.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRecipient, resolveRecipients } = require('../sites');

describe('resolveRecipient', () => {
  test('returns the per-form override when formRecipients has a matching key', () => {
    const site = {
      ownerEmail: 'owner@biz.com',
      formRecipients: { sales: 'sales@biz.com', careers: 'hr@biz.com' },
    };
    assert.equal(resolveRecipient(site, 'sales'), 'sales@biz.com');
    assert.equal(resolveRecipient(site, 'careers'), 'hr@biz.com');
  });

  test('falls back to ownerEmail when formType has no matching key in formRecipients', () => {
    const site = {
      ownerEmail: 'owner@biz.com',
      formRecipients: { sales: 'sales@biz.com' },
    };
    assert.equal(resolveRecipient(site, 'contact'), 'owner@biz.com');
    assert.equal(resolveRecipient(site, 'careers'), 'owner@biz.com');
  });

  test('falls back to ownerEmail when formRecipients is an empty object (default for every existing site)', () => {
    const site = { ownerEmail: 'owner@biz.com', formRecipients: {} };
    assert.equal(resolveRecipient(site, 'contact'), 'owner@biz.com');
    assert.equal(resolveRecipient(site, 'sales'), 'owner@biz.com');
  });

  test('falls back to ownerEmail when formRecipients is missing entirely (legacy sites.json shape)', () => {
    const site = { ownerEmail: 'owner@biz.com' };
    assert.equal(resolveRecipient(site, 'sales'), 'owner@biz.com');
  });

  test('defaults formType to "contact" when not provided, and resolves against that key', () => {
    const site = {
      ownerEmail: 'owner@biz.com',
      formRecipients: { contact: 'frontdesk@biz.com', sales: 'sales@biz.com' },
    };
    assert.equal(resolveRecipient(site, undefined), 'frontdesk@biz.com');
    assert.equal(resolveRecipient(site, ''), 'frontdesk@biz.com');
  });

  test('an empty-string value in formRecipients for a key is treated as unset (falls back to ownerEmail)', () => {
    const site = {
      ownerEmail: 'owner@biz.com',
      formRecipients: { sales: '' },
    };
    assert.equal(resolveRecipient(site, 'sales'), 'owner@biz.com');
  });

  test('returns null (not a throw) when site itself is null/undefined', () => {
    assert.equal(resolveRecipient(null, 'sales'), null);
    assert.equal(resolveRecipient(undefined, 'sales'), null);
  });

  test('ignores a non-object formRecipients (defensive) and falls back to ownerEmail', () => {
    const site = { ownerEmail: 'owner@biz.com', formRecipients: 'not-an-object' };
    assert.equal(resolveRecipient(site, 'sales'), 'owner@biz.com');
  });
});

describe('resolveRecipients (multi-recipient, 2026-09-23)', () => {
  test('a comma-separated formRecipients value splits into multiple trimmed addresses', () => {
    const site = {
      ownerEmail: 'owner@biz.com',
      formRecipients: { sales: 'sales@biz.com, manager@biz.com,  owner2@biz.com ' },
    };
    assert.deepEqual(resolveRecipients(site, 'sales'), [
      'sales@biz.com',
      'manager@biz.com',
      'owner2@biz.com',
    ]);
  });

  test('a single (no-comma) formRecipients value returns a 1-element array', () => {
    const site = { ownerEmail: 'owner@biz.com', formRecipients: { sales: 'sales@biz.com' } };
    assert.deepEqual(resolveRecipients(site, 'sales'), ['sales@biz.com']);
  });

  test('a comma-separated ownerEmail (fallback path) also splits into multiple addresses', () => {
    const site = { ownerEmail: 'owner@biz.com, backup@biz.com' };
    assert.deepEqual(resolveRecipients(site, 'contact'), ['owner@biz.com', 'backup@biz.com']);
  });

  test('trailing/leading commas and empty segments are dropped, not returned as blank entries', () => {
    const site = { ownerEmail: 'owner@biz.com', formRecipients: { sales: 'a@biz.com,,b@biz.com,' } };
    assert.deepEqual(resolveRecipients(site, 'sales'), ['a@biz.com', 'b@biz.com']);
  });

  test('no recipient configured anywhere → empty array (not null, not throw)', () => {
    assert.deepEqual(resolveRecipients(null, 'sales'), []);
    assert.deepEqual(resolveRecipients({}, 'sales'), []);
  });

  test('resolveRecipient (singular, deprecated) still returns just the first address for back-compat', () => {
    const site = { ownerEmail: 'owner@biz.com', formRecipients: { sales: 'sales@biz.com, manager@biz.com' } };
    assert.equal(resolveRecipient(site, 'sales'), 'sales@biz.com');
  });
});
