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

// Ограничение длины описания для вывода /latest, управляется env.DESC_MAX_CHARS
function truncateForLatest(text) {
  const max = Number(env.DESC_MAX_CHARS || 0);
  if (!max || max <= 0) return text;
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function formatLatestItem(v) {
  const descRaw = v.description || "";
  const descCropped = descRaw ? truncateForLatest(descRaw) : "";
  const desc = descCropped ? `\n${descCropped}` : "";
  const typeLine = v.type ? `\ntype: ${v.type}` : "";
  return `${v.title}\n${v.url}${typeLine}${desc}`;
}

function formatSearchItem(item) {
  const idxPrefix = typeof item.index === "number" ? `${item.index}. ` : "";
  const title = item.title || "(без названия)";
  const url = item.url || (item.id ? `https://youtu.be/${item.id}` : "");
  const score = typeof item.score === "number" ? item.score.toFixed(15) : item.score;
  const desc = (item.description_indexed || "").trim();

  let dateStr = null;
  const rawPublished = item.published_at;
  if (rawPublished) {
    const dt = new Date(rawPublished);
    dateStr = isNaN(dt.getTime()) ? String(rawPublished) : dt.toISOString().split("T")[0];
  }

  const typeStr = item.type ? String(item.type) : null;

  const headerLines = [
    `${idxPrefix}${title}`,
    url ? `${url}` : null,
    typeof score !== "undefined" ? `score: ${score}` : null,
    dateStr ? `date: ${dateStr}` : null,
    typeStr ? `type: ${typeStr}` : null,
  ].filter(Boolean);

  const body = desc ? `\n${desc}` : "";
  const text = `${headerLines.join("\n")}${body}`;
  // Возвращаем строку; разбиение по лимиту выполняет вызывающий код
  return text;
}

module.exports = {
  splitTextByLimit,
  truncateForLatest,
  formatLatestItem,
  formatSearchItem,
};