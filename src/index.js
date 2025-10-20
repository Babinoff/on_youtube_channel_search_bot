const { Bot } = require("grammy");
const { logger } = require("./config/logger");
const { env } = require("./config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("./services/youtube/client");
const { searchTopK } = require("./services/vector/lancedb");
const { formatLatestItem, formatSearchItem } = require("./services/telegram/format");
const { deriveType } = require("./services/youtube/classify");
const { getUserSettings, updateUserSettings, resetUserSettings } = require("./services/user/settings_store");
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

  // Хранилище ожидаемого ввода по кнопкам
  const pendingInputs = new Map(); // key: userId, value: { mode: 'search'|'latest', createdAt: number }

  // Основная клавиатура
  function buildMainKeyboard() {
    return {
      keyboard: [
        [{ text: '🔎 Поиск' }, { text: '🆕 Последние' }],
        [{ text: '⚙️ Настройки' }, { text: 'ℹ️ Помощь' }, { text: 'Отмена' }],
      ],
      resize_keyboard: true,
      input_field_placeholder: 'Введите запрос или используйте клавиатуру',
    };
  }

  // /start
  bot.command("start", async (ctx) => {
    await ctx.reply("Привет! Я бот для поиска релевантных YouTube‑видео. Попробуйте /help.", { reply_markup: buildMainKeyboard() });
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
      "/settings — настроить кнопками: тип выдачи, threshold и k",
      "/threshold <число> — установить глобальный порог (без перезапуска)",
      "\nТакже доступна клавиатура: 'Поиск', 'Последние', 'Настройки' и 'Помощь'."
    ].join("\n"), { reply_markup: buildMainKeyboard() });
  });

  // Кнопка: Поиск
  bot.hears('🔎 Поиск', async (ctx) => {
    pendingInputs.set(ctx.from.id, { mode: 'search', createdAt: Date.now() });
    await ctx.reply('Введите поисковый запрос:', { reply_markup: { force_reply: true } });
  });

  // Кнопка: Последние
  bot.hears('🆕 Последние', async (ctx) => {
    pendingInputs.set(ctx.from.id, { mode: 'latest', createdAt: Date.now() });
    await ctx.reply('Введите канал (или оставьте пустым):', { reply_markup: { force_reply: true } });
  });

  // Кнопка: Настройки
  bot.hears('⚙️ Настройки', async (ctx) => {
    const userId = ctx.from?.id;
    const s = getUserSettings(userId);
    const text = [
      'Настройки пользователя:',
      `Тип выдачи: ${s.type || 'не задан'}`,
      `threshold: ${typeof s.threshold === 'number' ? s.threshold.toFixed(2) : s.threshold}`,
      `k: ${s.k}`,
      `score: ${s.showScore ? 'показывать' : 'скрывать'}`,
      '\nВыберите кнопки ниже, чтобы обновить настройки.',
    ].join('\n');
    await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s) });
  });

  // Кнопка: Помощь
  bot.hears('ℹ️ Помощь', async (ctx) => {
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
      "/settings — настроить кнопками: тип выдачи, threshold и k",
      "/threshold <число> — установить глобальный порог (без перезапуска)"
    ].join("\n"), { reply_markup: buildMainKeyboard() });
  });

  // Кнопка: Отмена
  bot.hears('Отмена', async (ctx) => {
    pendingInputs.delete(ctx.from.id);
    await ctx.reply('Готово. Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
  });

  // Обработка ввода после ForceReply
  bot.on('message:text', async (ctx) => {
    const t = ctx.message?.text || '';
    if (!t || t.startsWith('/')) return; // не перехватываем команды
    const state = pendingInputs.get(ctx.from.id);
    if (!state) return;
    pendingInputs.delete(ctx.from.id);

    try {
      if (state.mode === 'search') {
        if (!requireEnvOrWarn('MISTRAL_API_KEY', ctx)) return;
        const raw = t.trim();
        if (!raw) { await ctx.reply('Введите поисковый запрос.'); return; }
        const partsExtra = raw.split('|');
        const query = partsExtra[0].trim();
        let maxDistance = env.SEARCH_MAX_DISTANCE;
        let topK = Number(env.SEARCH_TOP_K || 5);
        let typeFilter = null;
        const us = getUserSettings(ctx.from?.id);
        for (let i = 1; i < partsExtra.length; i++) {
          const extra = partsExtra[i] && partsExtra[i].trim();
          if (!extra) continue;
          const mThr = extra.match(/threshold\s*=\s*([0-9]*\.?[0-9]+)/i);
          if (mThr) { maxDistance = parseFloat(mThr[1]); continue; }
          const mK = extra.match(/k\s*=\s*([0-9]+)/i);
          if (mK) { topK = parseInt(mK[1], 10); continue; }
          const mType = extra.match(/type\s*=\s*([a-zA-Z]+)/i);
          if (mType) {
            const rawType = mType[1].toLowerCase();
            if (["short","shorts","короткое","шорт","шорты"].includes(rawType)) typeFilter = "short";
            else if (["stream","стрим","live","трансляция"].includes(rawType)) typeFilter = "stream";
            else if (["video","видео","regular","обычное"].includes(rawType)) typeFilter = "video";
          }
        }
        if (typeFilter == null && us.type) typeFilter = us.type;
        if (us && typeof us.threshold === 'number' && !/threshold\s*=/.test(raw)) maxDistance = us.threshold;
        if (us && typeof us.k === 'number' && !/k\s*=/.test(raw)) topK = us.k;
        const fetchK = typeFilter ? Math.max(topK * 2, topK + 5) : topK;
        const resultsRaw = await searchTopK(query, fetchK, { maxDistance });
        const results = typeFilter ? resultsRaw.filter(r => (r.type || 'video') === typeFilter).slice(0, topK) : resultsRaw;
        if (!results.length) {
          await ctx.reply(`Нет результатов при пороге ${maxDistance}${typeFilter ? ` и типе ${typeFilter}` : ''}. Попробуйте изменить threshold/k/type или другой запрос.`);
          return;
        }
        for (const r of results) {
          const line = formatSearchItem(us.showScore === false ? { ...r, score: undefined } : r);
          const parts = splitTextByLimit(line, 3800);
          for (const p of parts) { await ctx.reply(p); await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0)); }
        }
      } else if (state.mode === 'latest') {
        if (!requireEnvOrWarn('YOUTUBE_API_KEY', ctx)) return;
        const argFull = t.trim();
        const partsExtra = argFull ? argFull.split('|') : [];
        const channelSpec = partsExtra.length ? partsExtra[0].trim() : argFull;
        let typeFilter = null;
        for (let i = 1; i < partsExtra.length; i++) {
          const extra = partsExtra[i] && partsExtra[i].trim();
          if (!extra) continue;
          const mType = extra.match(/type\s*=\s*([a-zA-Z]+)/i);
          if (mType) {
            const rawType = mType[1].toLowerCase();
            if (["short","shorts","короткое","шорт","шорты"].includes(rawType)) typeFilter = "short";
            else if (["stream","стрим","live","трансляция"].includes(rawType)) typeFilter = "stream";
            else if (["video","видео","regular","обычное"].includes(rawType)) typeFilter = "video";
          }
        }
        const input = channelSpec || env.YOUTUBE_CHANNEL_ID;
        const us = getUserSettings(ctx.from?.id);
        if (typeFilter == null && us.type) typeFilter = us.type;
        const videosRaw = await fetchLatestVideos({ input, limit: 10 });
        const videos = typeFilter ? videosRaw.filter(v => (v.type || 'video') === typeFilter) : videosRaw;
        if (!videos.length) { await ctx.reply('Видео не найдены.'); return; }
        for (const item of videos.map(v => formatLatestItem(v))) {
          const parts = splitTextByLimit(item, 3800);
          for (const p of parts) { await ctx.reply(p); await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0)); }
        }
      }
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message || 'Ошибка';
      await ctx.reply(`Ошибка: ${msg}`);
    }
  });

  // Обработчик callback кнопок
  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery?.data || "";
    let s = getUserSettings(userId);

    try {
      if (data.startsWith("set_type:")) {
        const t = data.split(":")[1];
        const type = t === "none" ? null : (t === "short" || t === "stream" || t === "video" ? t : null);
        s = updateUserSettings(userId, { type });
        await ctx.answerCallbackQuery({ text: `Тип: ${type || 'не задан'}` });
      } else if (data.startsWith("set_threshold:")) {
        const stepStr = data.split(":")[1];
        const step = parseFloat(stepStr);
        const cur = typeof s.threshold === 'number' ? s.threshold : parseFloat(s.threshold) || 0.75;
        let next = cur + step;
        // Ограничим разумные пределы [0.3 .. 1.5]
        next = Math.max(0.3, Math.min(1.5, next));
        s = updateUserSettings(userId, { threshold: next });
        await ctx.answerCallbackQuery({ text: `threshold: ${next.toFixed(2)}` });
      } else if (data.startsWith("set_k:")) {
        const kn = parseInt(data.split(":")[1], 10);
        const k = Number.isFinite(kn) ? kn : s.k;
        s = updateUserSettings(userId, { k });
        await ctx.answerCallbackQuery({ text: `k: ${k}` });
      } else if (data === "toggle:score") {
        s = updateUserSettings(userId, { showScore: !s.showScore });
        await ctx.answerCallbackQuery({ text: s.showScore ? 'Показывать score' : 'Скрывать score' });
      } else if (data === "reset:all") {
        s = resetUserSettings(userId);
        await ctx.answerCallbackQuery({ text: 'Настройки сброшены' });
      } else {
        await ctx.answerCallbackQuery();
      }

      const text = [
        "Настройки пользователя:",
        `Тип выдачи: ${s.type || 'не задан'}`,
        `threshold: ${typeof s.threshold === 'number' ? s.threshold.toFixed(2) : s.threshold}`,
        `k: ${s.k}`,
        `score: ${s.showScore ? 'показывать' : 'скрывать'}`,
      ].join("\n");

      // Обновляем текст и клавиатуру
      try {
        await ctx.editMessageText(text, { reply_markup: buildSettingsKeyboard(s) });
      } catch {
        // Если нельзя редактировать (например, старое сообщение) — отправим новое
        await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s) });
      }
    } catch (err) {
      await ctx.answerCallbackQuery({ text: 'Ошибка' });
    }
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


function buildSettingsKeyboard(s) {
  const typeRow = [
    { text: `Shorts${s.type === 'short' ? ' ✅' : ''}`, callback_data: 'set_type:short' },
    { text: `Stream${s.type === 'stream' ? ' ✅' : ''}`, callback_data: 'set_type:stream' },
    { text: `Video${s.type === 'video' ? ' ✅' : ''}`, callback_data: 'set_type:video' },
    { text: `${s.type ? 'Сброс' : '—'}`, callback_data: 'set_type:none' },
  ];

  const thr = typeof s.threshold === 'number' ? s.threshold : parseFloat(s.threshold) || 0.75;
  const thrRow = [
    { text: 'threshold -0.05', callback_data: 'set_threshold:-0.05' },
    { text: `threshold ${thr.toFixed(2)}`, callback_data: 'noop' },
    { text: 'threshold +0.05', callback_data: 'set_threshold:+0.05' },
  ];

  const kRow = [
    { text: `k=3${s.k === 3 ? ' ✅' : ''}`, callback_data: 'set_k:3' },
    { text: `k=5${s.k === 5 ? ' ✅' : ''}`, callback_data: 'set_k:5' },
    { text: `k=10${s.k === 10 ? ' ✅' : ''}`, callback_data: 'set_k:10' },
  ];

  const miscRow = [
    { text: `${s.showScore ? 'Скрыть score' : 'Показывать score'}`, callback_data: 'toggle:score' },
    { text: 'Сбросить всё', callback_data: 'reset:all' },
  ];

  return { inline_keyboard: [typeRow, thrRow, kRow, miscRow] };
}