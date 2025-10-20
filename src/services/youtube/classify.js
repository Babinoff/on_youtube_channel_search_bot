const { env } = require("../../config/env");

function parseISODurationToSeconds(iso) {
  const s = String(iso || "");
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const mi = parseInt(m[2] || "0", 10);
  const se = parseInt(m[3] || "0", 10);
  return h * 3600 + mi * 60 + se;
}

function isShort(v) {
  const durSec = parseISODurationToSeconds(v?.contentDetails?.duration);
  const max = Number(env.SHORTS_MAX_SECONDS || 60);
  const text = `${v?.snippet?.title || ""} ${v?.snippet?.description || ""}`;
  const hashShorts = /#shorts/i.test(text);
  if (Number.isFinite(durSec) && durSec <= max) return true;
  return hashShorts;
}

function isStream(v) {
  const lbc = String(v?.snippet?.liveBroadcastContent || "none").toLowerCase();
  if (lbc !== "none") return true;
  const ls = v?.liveStreamingDetails || {};
  return Boolean(ls.actualStartTime || ls.scheduledStartTime);
}

function deriveType(v) {
  if (isStream(v)) return "stream";
  if (isShort(v)) return "short";
  return "video";
}

module.exports = { parseISODurationToSeconds, isShort, isStream, deriveType };