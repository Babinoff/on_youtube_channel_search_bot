const { env } = require("../../config/env");
const { stripAdLines: stripAdLinesC, stripAfterPatterns: stripAfterPatternsC, cleanText: cleanTextC } = require("../text/normalize");

// Безопасная отправка длинного текста: разбивает на части по лимиту Telegram (~4096)
function splitTextByLimit(text, maxLen = 3800) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      let breakPos = text.lastIndexOf("\n", end);
      if (breakPos <= start) breakPos = text.lastIndexOf(" ", end);
      if (breakPos <= start) breakPos = end;
      end = breakPos;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

// --- Нормализация описания по тем же правилам, что и индексация ---
function escapeRegex(s) { return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function stripAdLines(text) {
  const raw = text || "";
  const charsCsv = env.INDEX_DESC_AD_LINE_PREFIX_CHARS || "";
  const chars = charsCsv.split(",").map((c) => c.trim()).filter(Boolean);
  if (!chars.length) return raw;
  const re = new RegExp(`^\s*(?:${chars.map(escapeRegex).join("|")})\s*`, "i");
  const lines = raw.split(/\r?\n/);
  const filtered = lines.filter((ln) => !re.test(ln));
  return filtered.join("\n");
}
function stripAfterPatterns(text) {
  const raw = text || "";
  const csv = env.INDEX_DESC_STRIP_AFTER_PATTERNS || "";
  const pats = csv.split(",").map((p) => p.trim()).filter(Boolean);
  if (!pats.length) return raw;
  let cutAt = -1;
  const lower = raw.toLowerCase();
  for (const p of pats) {
    const pos = lower.indexOf(p.toLowerCase());
    if (pos >= 0) cutAt = cutAt >= 0 ? Math.min(cutAt, pos) : pos;
  }
  if (cutAt < 0) return raw;
  return raw.slice(0, cutAt).trim();
}
function cleanText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function truncateByChars(text, maxChars) {
  const limit = Number(maxChars || env.DESC_MAX_CHARS || 0);
  if (!limit || limit <= 0) return text || "";
  const s = String(text || "");
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}
function normalizeDescriptionForLatest(desc) {
  let s = desc || "";
  s = stripAdLinesC(s);
  s = stripAfterPatternsC(s);
  s = cleanTextC(s);
  s = truncateByChars(s, env.DESC_MAX_CHARS);
  return s;
}

// Общий форматтер для поиска и последних
function formatItem(item, { mode = "latest", includeScore = false, includeIndex = false } = {}) {
  const idxPrefix = includeIndex && typeof item.index === "number" ? `${item.index}. ` : "";
  const title = item.title || "(без названия)";
  const url = item.url || (item.id ? `https://youtu.be/${item.id}` : "");

  let dateStr = null;
  const rawPublished = item.publishedAt || item.published_at || null;
  if (rawPublished) {
    const dt = new Date(rawPublished);
    dateStr = isNaN(dt.getTime()) ? String(rawPublished) : dt.toISOString().split("T")[0];
  }

  const typeStr = item.type ? String(item.type) : null;
  const scoreVal = includeScore ? item.score : undefined;
  const scoreStr = typeof scoreVal === "number" ? scoreVal.toFixed(6) : scoreVal;

  const headerLines = [
    `${idxPrefix}${title}`,
    url ? `${url}` : null,
    typeof scoreStr !== "undefined" ? `score: ${scoreStr}` : null,
    dateStr ? `date: ${dateStr}` : null,
    typeStr ? `type: ${typeStr}` : null,
  ].filter(Boolean);

  let desc = "";
  if (mode === "search") {
    desc = (item.description_indexed || "").trim();
  } else {
    const descRaw = item.description || "";
    const descClean = descRaw ? normalizeDescriptionForLatest(descRaw) : "";
    desc = descClean;
  }
  const body = desc ? `\n${desc}` : "";
  return `${headerLines.join("\n")}${body}`;
}

// Ограничение длины описания для вывода /latest, управляется env.DESC_MAX_CHARS
function truncateForLatest(text) {
  const max = Number(env.DESC_MAX_CHARS || 0);
  if (!max || max <= 0) return text;
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function formatLatestItem(v) {
  return formatItem(v, { mode: "latest", includeScore: false, includeIndex: true });
}

function formatSearchItem(item) {
  return formatItem(item, { mode: "search", includeScore: true, includeIndex: true });
}

module.exports = {
  splitTextByLimit,
  truncateForLatest,
  formatItem,
  formatLatestItem,
  formatSearchItem,
};