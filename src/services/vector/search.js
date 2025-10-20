const { env } = require('../../config/env');
const { searchTopK } = require('./lancedb');

function clampK(k) {
  const maxK = Number(env.SEARCH_MAX_K || 20);
  const n = Math.max(1, Number(k) || 1);
  return Math.min(n, maxK);
}

function normalizeThreshold(threshold) {
  let t = typeof threshold === 'number' ? threshold : parseFloat(threshold);
  if (!isFinite(t)) t = Number(env.SEARCH_MAX_DISTANCE || 0.7);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return t;
}

function normalizeType(type) {
  const allowed = new Set([null, 'short', 'stream', 'video']);
  return allowed.has(type) ? type : null;
}

function ensureScoreKey(rows) {
  return (rows || []).map((r) => {
    if (typeof r.score === 'number') return r;
    const d = (typeof r._distance === 'number') ? r._distance
      : (typeof r.distance === 'number') ? r.distance
      : undefined;
    if (typeof d === 'number') {
      const { _distance, distance, ...rest } = r;
      return { ...rest, score: d };
    }
    return r;
  });
}

async function searchUnified(query, k, opts = {}) {
  const kk = clampK(k);
  const maxDistance = normalizeThreshold(opts.maxDistance ?? opts.threshold);
  const type = normalizeType(opts.type ?? null);
  const channelId = opts.channelId || null;
  const rows = await searchTopK(query, kk, { maxDistance, channelId, type });
  return ensureScoreKey(rows);
}

module.exports = {
  clampK,
  normalizeThreshold,
  normalizeType,
  ensureScoreKey,
  searchUnified,
};