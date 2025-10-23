const axios = require("axios");
const { env } = require("../../config/env");
const { splitTextByLimit } = require("../telegram/format");

function canNotify() {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.ADMIN_USER_ID);
}

async function sendAdmin(text, opts = {}) {
  if (!canNotify()) return { ok: false, reason: "no_admin" };
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.ADMIN_USER_ID;
  try {
    const parts = splitTextByLimit(String(text || ""), 3800);
    for (const p of parts) {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: p,
        disable_notification: Boolean(opts.silent),
      }, { timeout: 15000 });
    }
    return { ok: true };
  } catch (err) {
    const e = err?.response?.data || err?.message || String(err);
    return { ok: false, err: e };
  }
}

function fmtEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

async function notifyAdminProgress(meta = {}) {
  const { stage, channelId, total, current, inserted, limit, stoppedEarly, etaMs } = meta;
  const lines = [];
  lines.push("Индексация: прогресс");
  if (channelId) lines.push(`Канал: ${channelId}`);
  if (stage) lines.push(`Стадия: ${stage}`);
  const cur = Number(current || 0);
  const tot = Number(total || 0);
  if (tot > 0) {
    const pct = Math.round((cur / tot) * 100);
    lines.push(`Прогресс: ${cur}/${tot} (${isFinite(pct) ? pct : 0}%)`);
  }
  if (typeof inserted === "number") lines.push(`Вставлено: ${inserted}`);
  if (typeof limit === "number") lines.push(`Лимит: ${limit}`);
  if (stoppedEarly) lines.push("Инкрементальный стоп: да");
  const etaText = fmtEta(etaMs);
  if (etaText) lines.push(`ETA: ~${etaText}`);
  const text = lines.join("\n");
  return await sendAdmin(text);
}

module.exports = { sendAdmin, notifyAdminProgress, fmtEta, canNotify };