const { env } = require("../../config/env");
const { builders } = require("./callbacks");

function buildSettingsKeyboard(s, channels, isAdmin = false) {
  const typeRow = [
    { text: `Shorts${s.type === 'short' ? ' ✅' : ''}`, callback_data: builders.setType('short') },
    { text: `Stream${s.type === 'stream' ? ' ✅' : ''}`, callback_data: builders.setType('stream') },
    { text: `Video${s.type === 'video' ? ' ✅' : ''}`, callback_data: builders.setType('video') },
    { text: `${s.type ? 'Сброс' : '—'}`, callback_data: builders.setType('none') },
  ];

  const maxK = Number(env.SEARCH_MAX_K || 20);
  const curK = Number(s.k || 0) || 1;
  const kRow = [
    { text: 'k -5', callback_data: builders.setK('-5') },
    { text: `k ${curK}/${maxK}`, callback_data: builders.noop() },
    { text: 'k +5', callback_data: builders.setK('+5') },
  ];

  const channelRows = [];
  if (isAdmin) {
    for (let i = 0; i < channels.length; i += 2) {
      const a = channels[i];
      const b = channels[i + 1];
      const row = [];
      if (a) row.push({ text: `${s.channelId === a.id ? '✅ ' : ''}${a.title}`, callback_data: builders.setChannel(a.id) });
      if (b) row.push({ text: `${s.channelId === b.id ? '✅ ' : ''}${b.title}`, callback_data: builders.setChannel(b.id) });
      if (row.length) channelRows.push(row);
    }
  }

  const miscRow = [
    { text: s.showScore ? 'Скрыть score' : 'Показать score', callback_data: builders.toggleScore() },
    { text: 'Сбросить', callback_data: builders.resetAll() },
  ];

  const closeRow = [
    { text: 'Закрыть настройки', callback_data: builders.closeSettings() },
  ];

  return { inline_keyboard: [typeRow, kRow, ...channelRows, miscRow, closeRow] };
}

function buildMainKeyboard() {
  return {
    keyboard: [
      [{ text: '🔎 Поиск' }, { text: '🆕 Последние' }],
      [{ text: '⚙️ Настройки' }, { text: 'ℹ️ Помощь' }, { text: 'Отмена' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Введите запрос или используйте клавиатуру',
  };
}

module.exports = { buildSettingsKeyboard, buildMainKeyboard };