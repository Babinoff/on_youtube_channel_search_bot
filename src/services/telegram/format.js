const { env } = require("../../config/env");

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

// Ограничение длины описания для вывода /latest, управляется env.LATEST_DESC_MAX_CHARS
function truncateForLatest(text) {
  const max = Number(env.LATEST_DESC_MAX_CHARS || 0);
  if (!max || max <= 0) return text;
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function formatLatestItem(v) {
  const descRaw = v.description || "";
  const descCropped = descRaw ? truncateForLatest(descRaw) : "";
  const desc = descCropped ? `\n${descCropped}` : "";
  return `${v.title}\n${v.url}${desc}`;
}

function formatSearchItem(r) {
  const scoreStr = r.score !== undefined ? `\nscore: ${r.score}` : "";
  const desc = r.description_indexed ? `\n\n${r.description_indexed}` : (r.description ? `\n\n${r.description}` : "");
  return `${r.index}. ${r.title}\n${r.url}${scoreStr}${desc}`;
}

module.exports = {
  splitTextByLimit,
  truncateForLatest,
  formatLatestItem,
  formatSearchItem,
};