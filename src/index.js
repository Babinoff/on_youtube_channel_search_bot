const { Bot } = require("grammy");
const { logger, getLoggerCtx } = require("./config/logger");
const { env, validateEnv } = require("./config/env");

const { searchUnified } = require("./services/vector/search");
const { splitTextByLimit, formatLatestItem, formatSearchItem } = require("./services/telegram/format");
const { buildSettingsKeyboard, buildMainKeyboard } = require("./services/telegram/keyboards");

const { fetchLatestVideos } = require("./services/youtube/latest");
const { ACTIONS, parse } = require("./services/telegram/callbacks");
const { getUserSettings, updateUserSettings, resetUserSettings } = require("./services/user/settings_store");
const { setPendingInput, getPendingInput, clearPendingInput, hasPendingInput } = require("./services/telegram/state");
const { getAdminChannels } = require("./services/admin/channels_store");
const { applyAdminCommands, buildAdminHelpText } = require("./services/admin/router");
const { getActiveChannelId, setActiveChannel } = require("./services/admin/server_settings_store");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ранняя проверка окружения
const validation = validateEnv();
if (!validation.ok) {
  logger.error("Остановка: ошибки окружения");
  process.exit(1);
}

function requireEnvOrWarn(name, ctx) {
  const val = env[name];
  if (!val) {
    const msg = `${name} отсутствует в .env — заполните перед проверкой.`;
    logger.warn(msg);
    if (ctx) ctx.reply(msg);
  }
  return val;
}



// Удаляю вспомогательную склейку сообщений, форматирование теперь в services/telegram/format
// function splitItemsIntoMessages(...) { /* removed */ }

// Удаляю локальный truncateForLatest, он теперь в services/telegram/format
// function truncateForLatest(...) { /* removed */ }

// fetchLatestVideos moved to services/youtube/latest.js

async function main() {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN отсутствует. Заполните .env и повторите.");
    process.exit(1);
  }
  const bot = new Bot(token);

  applyAdminCommands(bot);

  const defaultMessage = 'Выберите действие на клавиатуре: 🔎 Поиск, 🆕 Последние, ⚙️ Настройки, ℹ️ Помощь';

  bot.command("start", async (ctx) => {
    await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
  });

  bot.hears('🔎 Поиск', async (ctx) => {
    setPendingInput(ctx.from.id, { mode: 'search' });
    await ctx.reply('Введите запрос для поиска (или "Отмена")', { reply_markup: buildMainKeyboard() });
  });

  bot.hears('🆕 Последние', async (ctx) => {
    const s = getUserSettings(ctx.from.id);
    const k = Math.max(1, Number(s?.k) || 1);
    const type = s?.type || null;

    requireEnvOrWarn('YOUTUBE_API_KEY', ctx);
    const waitMsg = await ctx.reply('Получаю последние видео…');
    const typingTimer = setInterval(() => { ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {}); }, 4500);
    try {
      const input = await getActiveChannelId();
      let items = await fetchLatestVideos({ input, limit: k, type });
      let note = '';
      if (!items.length && type) {
        clearInterval(typingTimer);
        try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Видео выбранного типа не найдены.'); } catch {}
        await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
        return;
      }

      if (!items.length) {
        clearInterval(typingTimer);
        try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Видео не найдены.'); } catch {}
        await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
        return;
      }
      for (const [i, v] of items.entries()) {
        const text = formatLatestItem({ ...v, index: i + 1 });
        const parts = splitTextByLimit(text, 3800);
        for (const p of parts) {
          await ctx.reply(p);
          await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0));
        }
      }
      clearInterval(typingTimer);
      try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Готово.'); } catch {}
      await ctx.reply(`Готово. Показано ${items.length} видео.${note ? ' ' + note : ''} ${defaultMessage}`, { reply_markup: buildMainKeyboard() });
    } catch (err) {
      clearInterval(typingTimer);
      try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Ошибка'); } catch {}
      const logLatest = getLoggerCtx(ctx, { action: 'latest' });
      logLatest.error({ err: err?.message || err }, 'Ошибка /latest');
      await ctx.reply(`Ошибка: ${err?.message || err}`);
      await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
    }
  });

  // Обработчик ввода текста
  bot.on('message:text', async (ctx, next) => {
    const state = getPendingInput(ctx.from.id);
    // Вне режима ожидания ввода пробрасываем дальше к другим хендлерам
    if (!state) return next();

    if (state.mode === 'search') {
      const raw = (ctx.message?.text || '').trim();
      // Поддержка отмены из клавиатуры во время ожидания ввода
      if (raw.toLowerCase() === 'отмена') {
        clearPendingInput(ctx.from.id);
        await ctx.reply('Отменено. ' + defaultMessage, { reply_markup: buildMainKeyboard() });
        return;
      }

      clearPendingInput(ctx.from.id);
      let query = raw;
      let k = Math.max(1, Number(getUserSettings(ctx.from.id)?.k) || 1);
      const threshold = Number(env.SEARCH_MAX_DISTANCE);
      let typeFilter = getUserSettings(ctx.from.id)?.type || null;

      // Поддержка параметров через "|"
      if (raw.includes('|')) {
        const parts = raw.split('|').map(p => p.trim()).filter(Boolean);
        query = (parts.shift() || '').trim();
        for (const p of parts) {
          const mType = p.match(/^type\s*=\s*(short|stream|video)/i);
          if (mType) typeFilter = mType[1];
        }
      }

      if (!query) {
        await ctx.reply('Пустой запрос.');
        await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
        return;
      }

      // Сообщение ожидания и индикатор набора
      const waitMsg = await ctx.reply('Идёт поиск… Сервер размышляет…');
      const typingTimer = setInterval(() => {
        ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
      }, 4500);

      try {
        const us = getUserSettings(ctx.from.id);
        const activeId = await getActiveChannelId();
        const logSearch = getLoggerCtx(ctx, { action: 'search' });
        logSearch.info({ query, k, type: typeFilter, channelId: activeId }, `Запрос поиска: "${query}" | k=${k} type=${typeFilter || 'none'}`);
        const results = await searchUnified(query, k, { channelId: activeId, type: typeFilter });

        if (!results.length) {
          clearInterval(typingTimer);
          try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Ничего не найдено.'); } catch {}
          await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
          return;
        }

        for (const [i, r] of results.entries()) {
          const base = { ...r, index: i + 1 };
          const item = us?.showScore ? base : { ...base, score: undefined };
          const text = formatSearchItem(item);
          const parts = splitTextByLimit(text, 3800);
          for (const p of parts) {
            await ctx.reply(p);
            await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0));
          }
        }
        clearInterval(typingTimer);
        try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Готово.'); } catch {}
        await ctx.reply(`Готово. Показано ${results.length} видео. ${defaultMessage}`, { reply_markup: buildMainKeyboard() });
      } catch (err) {
        clearInterval(typingTimer);
        try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Ошибка поиска'); } catch {}
        const logSearch = getLoggerCtx(ctx, { action: 'search' });
        logSearch.error({ err: err?.message || err }, `Ошибка поиска: "${query}" | k=${k} type=${typeFilter || 'none'}`);
        await ctx.reply(`Ошибка поиска: ${err?.message || err}`);
        await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
      }
    }
  });

  // Кнопка: Настройки — показать inline‑клавиатуру с чекбоксами
  bot.hears('⚙️ Настройки', async (ctx) => {
    const userId = ctx.from?.id;
    const isAdmin = env.ADMIN_USER_ID ? String(userId) === String(env.ADMIN_USER_ID) : false;
    let s = getUserSettings(userId);
    const channels = await getAdminChannels();
    const activeId = await getActiveChannelId();
    const s2 = { ...s, channelId: activeId };
  
    const text = [
      'Настройки пользователя:',
      `Тип выдачи: ${s2.type || 'не задан'}`,
      `Количество видео: ${s2.k}`,
      `score: ${s2.showScore ? 'показывать' : 'скрывать'}`,
    ].join('\n');
  
    await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s2, channels, isAdmin) });
  });
  // Дублирующий хендлер без эмодзи для клиентов, присылающих только текст
  bot.hears('Настройки', async (ctx) => {
    const userId = ctx.from?.id;
    const isAdmin = env.ADMIN_USER_ID ? String(userId) === String(env.ADMIN_USER_ID) : false;
    let s = getUserSettings(userId);
    const channels = await getAdminChannels();
    const activeId = await getActiveChannelId();

    const s2 = { ...s, channelId: activeId };

    const text = [
      'Настройки пользователя:',
      `Тип выдачи: ${s2.type || 'не задан'}`,
      `Количество видео: ${s2.k}`,
      `score: ${s2.showScore ? 'показывать' : 'скрывать'}`,
    ].join('\n');

    await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s2, channels, isAdmin) });
  });

  // Кнопка: Помощь — вывести описание и вернуть клавиатуру
  bot.hears('ℹ️ Помощь', async (ctx) => {
    await ctx.reply([
      'Как пользоваться ботом через клавиатуру:',
      '• "🔎 Поиск" — введите запрос; количество результатов берётся из ⚙️ Настроек.',
      '• "🆕 Последние" — показывает последние N видео активного канала.',
      '• "⚙️ Настройки" — настройка типа выдачи и количества видео.',
      '• "ℹ️ Помощь" — краткая справка.',
      '• "Отмена" — сброс ожидаемого ввода.',
      '\nПодсказка: количество видео на выдаче настраивается в ⚙️ Настройках; максимум ограничен SEARCH_MAX_K.'
    ].join('\n'), { reply_markup: buildMainKeyboard() });
  });
  // Дублирующий хендлер без эмодзи
  bot.hears('Помощь', async (ctx) => {
    await ctx.reply([
      'Как пользоваться ботом через клавиатуру:',
      '• "Поиск" — введите запрос; количество результатов берётся из Настроек.',
      '• "Последние" — показывает последние N видео активного канала.',
      '• "Настройки" — настройка типа выдачи и количества видео.',
      '• "Помощь" — краткая справка.',
      '• "Отмена" — сброс ожидаемого ввода.',
      '\nПодсказка: количество видео на выдаче настраивается в Настройках; максимум ограничен SEARCH_MAX_K.'
    ].join('\n'), { reply_markup: buildMainKeyboard() });
  });

  // Кнопка: Отмена — очистить ожидаемый ввод и показать клавиатуру
  bot.hears('Отмена', async (ctx) => {
    clearPendingInput(ctx.from.id);
    await ctx.reply('Отменено. ' + defaultMessage, { reply_markup: buildMainKeyboard() });
  });

  // Скрытая команда для администратора: список админ-команд
  bot.command("admin", async (ctx) => {
    const isAdmin = env.ADMIN_USER_ID ? String(ctx.from?.id) === String(env.ADMIN_USER_ID) : false;
    if (!isAdmin) {
      return;
    }
    const adminHelp = buildAdminHelpText();
    await ctx.reply(adminHelp);
  });

  // Catch‑all: только неизвестные сообщения вне режима ввода — показать основное меню
  const knownButtons = new Set(['🔎 Поиск', '🆕 Последние', '⚙️ Настройки', 'ℹ️ Помощь', 'Отмена', 'Настройки', 'Помощь', 'Настройки']);
  bot.on('message', async (ctx) => {
    const txt = ctx.message?.text;
    if (typeof txt === 'string' && knownButtons.has(txt)) return;
    if (typeof txt === 'string' && txt.startsWith('/')) return; // не перехватываем Telegram-команды
    if (hasPendingInput(ctx.from.id)) return;
    await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
  });

  // Обработчик callback кнопок
  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from?.id;
    const isAdmin = env.ADMIN_USER_ID ? String(userId) === String(env.ADMIN_USER_ID) : false;
    const data = ctx.callbackQuery?.data || "";
    const { action, value } = parse(data);
    let s = getUserSettings(userId);
    const channels = await getAdminChannels();
    const activeId = await getActiveChannelId();
    let s2 = { ...s, channelId: activeId };
    const logSettings = getLoggerCtx(ctx, { action: 'settings' });
  
    try {
      if (action === ACTIONS.SET_TYPE) {
        const type = value === "none" ? null : (value === "short" || value === "stream" || value === "video" ? value : null);
        s2 = updateUserSettings(userId, { type });
        logSettings.info({ action, value: type }, `Настройки: SET_TYPE -> ${type || 'none'}`);
        await ctx.answerCallbackQuery({ text: `Тип: ${type || 'не задан'}` });
      } else if (action === ACTIONS.SET_K) {
        const delta = parseInt(value, 10);
        const maxK = Number(env.SEARCH_MAX_K || 20);
        const cur = Number(s2.k || 0) || 1;
        let next = cur + (Number.isFinite(delta) ? delta : 0);
        next = Math.max(1, Math.min(maxK, next));
        s2 = updateUserSettings(userId, { k: next });
        logSettings.info({ action, delta, from: cur, to: next, maxK }, `Настройки: SET_K -> ${next}/${maxK} (delta=${delta})`);
        await ctx.answerCallbackQuery({ text: `Количество: ${next}/${maxK}` });
      } else if (action === ACTIONS.TOGGLE && value === 'score') {
        s2 = updateUserSettings(userId, { showScore: !s2.showScore });
        logSettings.info({ action, showScore: s2.showScore }, `Настройки: TOGGLE score -> ${s2.showScore ? 'on' : 'off'}`);
        await ctx.answerCallbackQuery({ text: s2.showScore ? 'Показывать score' : 'Скрывать score' });
      } else if (action === ACTIONS.RESET && value === 'all') {
        s2 = resetUserSettings(userId);
        logSettings.info({ action }, 'Настройки: RESET all');
        await ctx.answerCallbackQuery({ text: 'Настройки сброшены' });
      } else if (action === ACTIONS.SET_CHANNEL) {
        if (!isAdmin) {
          await ctx.answerCallbackQuery({ text: 'Недоступно: только администратор' });
        } else {
          const cid = value;
          const allowedIds = channels.map(c => c.id);
          if (!allowedIds.includes(cid)) {
            logSettings.info({ action, attempted: cid }, 'Настройки: SET_CHANNEL -> not allowed');
            await ctx.answerCallbackQuery({ text: 'Канал не разрешён администратором' });
          } else {
            await setActiveChannel(cid);
            logSettings.info({ action, channelId: cid }, 'Настройки: SET_CHANNEL -> active changed');
            await ctx.answerCallbackQuery({ text: 'Активный канал изменён' });
          }
        }
      } else if (action === ACTIONS.CLOSE && value === 'settings') {
        logSettings.info({ action }, 'Настройки: CLOSE settings');
        await ctx.answerCallbackQuery({ text: 'Закрыто' });
        try { await ctx.editMessageReplyMarkup(); } catch {}
        await ctx.reply(`Готово. ${defaultMessage}`, { reply_markup: buildMainKeyboard() });
        return;
      } else {
        await ctx.answerCallbackQuery();
      }
  
      const currentActive = await getActiveChannelId();
      const finalSettings = { ...getUserSettings(userId), channelId: currentActive };
      const text = [
        "Настройки пользователя:",
        `Тип выдачи: ${finalSettings.type || 'не задан'}`,
        `Количество видео: ${finalSettings.k}`,
        `score: ${finalSettings.showScore ? 'показывать' : 'скрывать'}`,
      ].join("\n");
  
      try {
        await ctx.editMessageText(text, { reply_markup: buildSettingsKeyboard(finalSettings, channels, isAdmin) });
      } catch {
        await ctx.reply(text, { reply_markup: buildSettingsKeyboard(finalSettings, channels, isAdmin) });
      }
    } catch (err) {
      const logSettings = getLoggerCtx(ctx, { action: 'settings' });
      logSettings.error({ err: err?.message || err }, 'Ошибка обработки callback');
      try { await ctx.answerCallbackQuery({ text: 'Ошибка' }); } catch {}
    }
  });

  // Глобальный обработчик ошибок
  bot.catch((err) => {
    try {
      const log = getLoggerCtx(err?.ctx, { area: 'bot' });
      log.error({ err }, 'BotError');
    } catch (e) { console.error('BotError', err); }
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