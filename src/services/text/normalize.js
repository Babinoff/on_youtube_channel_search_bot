const { env } = require("../../config/env");

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAdLines(text) {
  const raw = text || "";
  const charsCsv = env.INDEX_DESC_AD_LINE_PREFIX_CHARS || "";
  const chars = charsCsv.split(",").map((c) => c.trim()).filter(Boolean);
  if (!chars.length) return raw;
  const re = new RegExp(`^\\s*(?:${chars.map(escapeRegex).join("|")})\\s*`, "i");
  const lines = raw.split(/\r?\n/);
  const filtered = lines.filter((ln) => !re.test(ln));
  return filtered.join("\n");
}

function stripAfterPatterns(text) {
  const raw = text || "";
  const csv = env.INDEX_DESC_STRIP_AFTER_PATTERNS || "";
  const patterns = csv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!patterns.length) return raw;
  let idx = -1;
  const lower = raw.toLowerCase();
  for (const p of patterns) {
    const pos = lower.indexOf(String(p).toLowerCase());
    if (pos >= 0) {
      idx = idx >= 0 ? Math.min(idx, pos) : pos;
    }
  }
  if (idx < 0) return raw;
  return raw.slice(0, idx).trim();
}

function truncateByChars(text, maxChars) {
  const max = Number(maxChars || env.DESC_MAX_CHARS || 0);
  if (!max || max <= 0) return text || "";
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeDescription(desc) {
  let s = desc || "";
  s = stripAdLines(s);
  s = stripAfterPatterns(s);
  s = cleanText(s);
  s = truncateByChars(s, env.DESC_MAX_CHARS);
  return s;
}

module.exports = {
  cleanText,
  escapeRegex,
  stripAdLines,
  stripAfterPatterns,
  truncateByChars,
  normalizeDescription,
};