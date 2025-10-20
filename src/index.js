const { Bot } = require("grammy");
const { logger } = require("./config/logger");
const { env } = require("./config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("./services/youtube/client");
const { searchTopK } = require("./services/vector/lancedb");
const { formatLatestItem, formatSearchItem } = require("./services/telegram/format");
const { deriveType } = require("./services/youtube/classify");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireEnvOrWarn(name, ctx) {
  const val = env[name];
  if (!val) {
    const msg = `${name} отсутствует в .env — заполните перед проверкой.`;
    logger.warn(msg);
    if (ctx) ctx.reply(msg);
  }
  return val;
}

// Безопасная отправка длинного текста: разбивает на части по лимиту Telegram (~4096)
function splitTextByLimit(text, maxLen = 3800) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      // попытка разрыва по \n или пробелу
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

// Удаляю вспомогательную склейку сообщений, форматирование теперь в services/telegram/format
// function splitItemsIntoMessages(...) { /* removed */ }

// Удаляю локальный truncateForLatest, он теперь в services/telegram/format
// function truncateForLatest(...) { /* removed */ }

async function fetchLatestVideos({ input, limit = 10 }) {
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  const channelId = input ? (input.match(/^UC/) ? input : await resolveChannelId(input, client)) : env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error("Не задан канал: добавьте YOUTUBE_CHANNEL_ID в .env или укажите аргумент.");

  const uploadsId = await getUploadsPlaylistId(channelId, client);
  const page = await listUploadsVideos(uploadsId, client);
  const videoIds = (page.items || []).map(i => i.contentDetails?.videoId).filter(Boolean).slice(0, limit);
  const details = videoIds.length ? await getVideosDetails(videoIds, client) : [];
  return details.map(v => ({
    id: v.id,
    title: v.snippet?.title || "",
    description: v.snippet?.description || "",
    url: `https://youtu.be/${v.id}`,
    type: deriveType(v),
  }));
}

async function main() {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN отсутствует — заполните .env");
    process.exit(1);
  }
  if (!env.YOUTUBE_API_KEY) {
    logger.warn("YOUTUBE_API_KEY отсутствует — команда /latest работать не будет");
  }

  const bot = new Bot(token);

  // /start
  bot.command("start", async (ctx) => {
    await ctx.reply("Привет! Я бот для поиска релевантных YouTube‑видео. Попробуйте /help.");
  });

  // /help
  bot.command("help", async (ctx) => {
    await ctx.reply([
      "Команды:",
      "/latest [канал] — показать последние 10 видео канала.",
      "Если канал не указан, используется YOUTUBE_CHANNEL_ID из .env.",
      "Поддерживает фильтр типа: /latest [канал] | type=short|stream|video",
      "Примеры: /latest, /latest @handle, /latest https://youtube.com/channel/UC...",
      "/search <запрос> — семантический поиск по локальной таблице LanceDB.",
      "Можно указать порог совпадения: /search <запрос> | threshold=0.75",
      "Можно указать количество результатов: /search <запрос> | k=10",
      "Фильтр типа результата: /search <запрос> | type=short|stream|video",
      "/threshold <число> — установить глобальный порог (без перезапуска)",
    ].join("\n"));
  });

  // /latest
  bot.command("latest", async (ctx) => {
    try {
      if (!requireEnvOrWarn("YOUTUBE_API_KEY", ctx)) return;
      const text = ctx.message?.text || "";
      const argFull = text.split(" ").slice(1).join(" ").trim();
      const partsExtra = argFull ? argFull.split("|") : [];
      const channelSpec = partsExtra.length ? partsExtra[0].trim() : argFull;
      let typeFilter = null;
      for (let i = 1; i < partsExtra.length; i++) {
        const extra = partsExtra[i] && partsExtra[i].trim();
        if (!extra) continue;
        const mType = extra.match(/type\s*=\s*([a-zA-Z]+)/i);
        if (mType) {
          const raw = mType[1].toLowerCase();
          if (["short","shorts","короткое","шорт","шорты"].includes(raw)) typeFilter = "short";
          else if (["stream","стрим","live","трансляция"].includes(raw)) typeFilter = "stream";
          else if (["video","видео","regular","обычное"].includes(raw)) typeFilter = "video";
        }
      }

      const input = channelSpec || env.YOUTUBE_CHANNEL_ID;
      const videosRaw = await fetchLatestVideos({ input, limit: 10 });
      const videos = typeFilter ? videosRaw.filter(v => (v.type || "video") === typeFilter) : videosRaw;
      if (!videos.length) {
        await ctx.reply("Видео не найдены.");
        return;
      }
      const items = videos.map(v => formatLatestItem(v));
      // Отправляем по одному сообщению на видео (с учётом лимита длины)
      for (const item of items) {
        const parts = splitTextByLimit(item, 3800);
        for (const p of parts) {
          await ctx.reply(p);
          await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0));
        }
      }
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message || "Ошибка при получении видео";
      logger.error({ err: msg }, "Ошибка /latest");
      await ctx.reply(`Ошибка: ${msg}`);
    }
  });

  // /search
  bot.command("search", async (ctx) => {
    try {
      if (!requireEnvOrWarn("MISTRAL_API_KEY", ctx)) return;
      const text = ctx.message?.text || "";
      const raw = text.split(" ").slice(1).join(" ").trim();
      if (!raw) {
        await ctx.reply("Использование: /search <запрос> | threshold=0.75 | k=10 | type=short|stream|video");
        return;
      }
      // Параметры через суффиксы после "|": threshold=0.75, k=10, type=short|stream|video
      const partsExtra = raw.split("|");
      const query = partsExtra[0].trim();
      let maxDistance = env.SEARCH_MAX_DISTANCE;
      let topK = Number(env.SEARCH_TOP_K || 5);
      let typeFilter = null;
      for (let i = 1; i < partsExtra.length; i++) {
        const extra = partsExtra[i] && partsExtra[i].trim();
        if (!extra) continue;
        const mThr = extra.match(/threshold\s*=\s*([0-9]*\.?[0-9]+)/i);
        if (mThr) {
          const v = parseFloat(mThr[1]);
          if (!Number.isNaN(v)) maxDistance = v;
        }
        const mK = extra.match(/k\s*=\s*([0-9]+)/i);
        if (mK) {
          const kVal = parseInt(mK[1], 10);
          if (!Number.isNaN(kVal) && kVal > 0 && kVal <= 50) topK = kVal;
        }
        const mType = extra.match(/type\s*=\s*([a-zA-Z]+)/i);
        if (mType) {
          const rawType = mType[1].toLowerCase();
          if (["short","shorts","короткое","шорт","шорты"].includes(rawType)) typeFilter = "short";
          else if (["stream","стрим","live","трансляция"].includes(rawType)) typeFilter = "stream";
          else if (["video","видео","regular","обычное"].includes(rawType)) typeFilter = "video";
        }
      }

      const fetchK = typeFilter ? Math.max(topK * 3, topK + 20) : topK;
      const resultsRaw = await searchTopK(query, fetchK, { maxDistance });
      const results = typeFilter
        ? resultsRaw.filter(r => (r.type || "video") === typeFilter).slice(0, topK)
        : resultsRaw;

      if (!results.length) {
        await ctx.reply(`Нет результатов при пороге ${maxDistance}${typeFilter ? ` и типе ${typeFilter}` : ""}. Попробуйте изменить threshold/k/type или другой запрос.`);
        return;
      }
      // Отправляем по одному сообщению на результат (с учётом лимита длины)
      for (const r of results) {
        const line = formatSearchItem(r);
        const parts = splitTextByLimit(line, 3800);
        for (const p of parts) {
          await ctx.reply(p);
          await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0));
        }
      }
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message || "Ошибка при поиске";
      logger.error({ err: msg }, "Ошибка /search");
      await ctx.reply(`Ошибка: ${msg}`);
    }
  });

  // Команда для установки глобального порога
  bot.command("threshold", async (ctx) => {
    const text = ctx.message?.text || "";
    const m = text.match(/\/threshold\s+([0-9]*\.?[0-9]+)/i);
    if (!m) {
      return ctx.reply("Использование: /threshold <число>. Пример: /threshold 0.75");
    }
    const v = parseFloat(m[1]);
    if (Number.isNaN(v)) return ctx.reply("Некорректное число.");
    env.SEARCH_MAX_DISTANCE = v;
    return ctx.reply(`Глобальный порог обновлён: ${v}`);
  });

  // Запуск polling
  logger.info("Запускаю бота (polling)…");
  bot.start();

  // Корректное завершение
  process.once("SIGINT", () => {
    logger.info("SIGINT — останавливаю бота");
    bot.stop();
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM — останавливаю бота");
    bot.stop();
  });
}

main().catch((err) => {
  logger.error({ err: err?.message }, "Фатальная ошибка запуска бота");
  process.exit(1);
});