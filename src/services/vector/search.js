const { env } = require('../../config/env');
const { searchTopK } = require('./lancedb');
const { normalizeQueryText } = require('../text/query_normalize');
const { logger } = require('../../config/logger');

function clampK(k) {
  const maxK = Number(env.SEARCH_MAX_K || 20);
  const n = Math.max(1, Number(k) || 1);
  return Math.min(n, maxK);
}

function normalizeThreshold(threshold) {
  // Parse numeric or fall back to env.SEARCH_MAX_DISTANCE; clamp to >= 0
  const parsed = (typeof threshold === 'number') ? threshold : parseFloat(threshold);
  let t = Number.isFinite(parsed) ? parsed : Number(env.SEARCH_MAX_DISTANCE || 0.7);
  if (t < 0) {
    try {
      logger.warn({ original: parsed }, 'normalizeThreshold: clamped negative to 0');
    } catch {}
    t = 0;
  }
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
  // Use only env.SEARCH_MAX_DISTANCE as the effective threshold
  const maxDistance = Number(env.SEARCH_MAX_DISTANCE || 0.7);
  const type = normalizeType(opts.type ?? null);
  const channelId = opts.channelId || null;
  const cleanedQuery = env.SEARCH_NORMALIZE_QUERY ? normalizeQueryText(query) : String(query || "");
  const rows = await searchTopK(cleanedQuery, kk, { maxDistance, channelId, type });
  return ensureScoreKey(rows);
}

module.exports = {
  clampK,
  normalizeThreshold,
  normalizeType,
  ensureScoreKey,
  searchUnified,
};