// Single entitlement layer for the MVP. Reads config/features.json (the one
// source of truth) and answers two questions for any feature key:
//   - isVisible(key): is it part of the MVP at all, or cut/hidden?
//   - isEntitled(key, user): is this user allowed to use it (free, or premium)?
//
// The same config is handed to the client at /js/features.js (see server.js)
// so the UI hides cut features and shows locked states for paid ones, but the
// SERVER is the real gate: requireFeature() below is what actually stops a
// free user calling a paid endpoint or a cut endpoint directly. The baseline
// audit flagged that scattered per-endpoint checks are easy to miss; routing
// every gate through here fixes that.
//
// Any key NOT present in the config defaults to free + visible.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'features.json');

// Read fresh on each call so a deploy (git pull of features.json) takes effect
// without a process restart. The file is tiny and these calls are low volume.
function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[features] config read failed, treating all as free+visible:', e.message);
    return {};
  }
}

function tierOf(key) {
  const c = load()[key];
  return (c && c.tier) || 'free';
}

function isVisible(key) {
  const c = load()[key];
  return !c || c.mvp !== false;
}

// Premium is only valid while it hasn't lapsed. The audit flagged that gates
// read subscription_tier as a bare string without honouring premium_until, so
// a cancelled-but-not-yet-webhooked sub could still pass. This closes that.
function isPremiumUser(user) {
  if (!user || user.subscription_tier !== 'premium') return false;
  if (user.premium_until && new Date(user.premium_until) < new Date()) return false;
  return true;
}

function isEntitled(key, user) {
  return tierOf(key) === 'free' || isPremiumUser(user);
}

// Express middleware. 404 a cut feature (it does not exist in this release),
// 403 a paid feature for a free user. Mount on any route that belongs to a
// gated or cut feature: router.post('/x', requireFeature('marketplace'), handler).
function requireFeature(key) {
  return (req, res, next) => {
    if (!isVisible(key)) return res.status(404).json({ error: 'not_found' });
    if (!isEntitled(key, req.user)) {
      return res.status(403).json({ error: 'premium_required', message: 'This is a premium feature.' });
    }
    next();
  };
}

module.exports = { load, tierOf, isVisible, isPremiumUser, isEntitled, requireFeature };
