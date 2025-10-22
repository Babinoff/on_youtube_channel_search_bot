import { describe, it, expect } from 'vitest';
import { env } from '../src/config/env';
import { buildSettingsKeyboard, buildMainKeyboard } from '../src/services/telegram/keyboards';
import { ACTIONS, parse } from '../src/services/telegram/callbacks';

describe('telegram keyboards', () => {
  it('buildMainKeyboard returns expected layout and properties', () => {
    const kb = buildMainKeyboard();
    expect(kb).toHaveProperty('keyboard');
    expect(Array.isArray(kb.keyboard)).toBe(true);
    expect(kb.resize_keyboard).toBe(true);
    expect(kb.is_persistent).toBe(true);
    expect(typeof kb.input_field_placeholder).toBe('string');

    expect(kb.keyboard[0][0].text).toBe('🔎 Поиск');
    expect(kb.keyboard[0][1].text).toBe('🆕 Последние');
    expect(kb.keyboard[1].map(b => b.text)).toEqual(['⚙️ Настройки', 'ℹ️ Помощь', 'Отмена']);
  });

  it('buildSettingsKeyboard reflects settings and uses structured callback_data', () => {
    const s = { type: 'short', k: 7, showScore: true, channelId: 'UC123' };
    const channels = [
      { id: 'UC123', title: 'Channel A' },
      { id: 'UC999', title: 'Channel B' },
      { id: 'UC777', title: 'Channel C' },
    ];

    const kb = buildSettingsKeyboard(s, channels, true);
    expect(kb).toHaveProperty('inline_keyboard');
    const rows = kb.inline_keyboard;
    const channelRowCount = Math.ceil(channels.length / 2);
    expect(rows.length).toBe(1 + 1 + channelRowCount + 1 + 1); // Removed 1 for threshold row

    const typeRow = rows[0];
    expect(typeRow[0].text).toContain('Shorts');
    expect(typeRow[0].text).toContain('✅');
    expect(parse(typeRow[0].callback_data).action).toBe(ACTIONS.SET_TYPE);

    // Adjusted row index for kRow due to threshold row removal
    const kRow = rows[1];
    expect(kRow[1].text).toBe(`Количество ${s.k}/${env.SEARCH_MAX_K}`);
    expect(parse(kRow[0].callback_data)).toEqual({ action: ACTIONS.SET_K, value: '-5' });
    expect(parse(kRow[2].callback_data)).toEqual({ action: ACTIONS.SET_K, value: '+5' });

    const firstChannelRow = rows[2]; // Adjusted row index
    expect(firstChannelRow[0].text.startsWith('✅ ')).toBe(true);
    expect(firstChannelRow[0].text.endsWith('Channel A')).toBe(true);
    expect(parse(firstChannelRow[0].callback_data)).toEqual({ action: ACTIONS.SET_CHANNEL, value: 'UC123' });

    const miscRow = rows[rows.length - 2];
    expect(miscRow[0].text).toBe('Скрыть score');
    expect(parse(miscRow[0].callback_data)).toEqual({ action: ACTIONS.TOGGLE, value: 'score' });
    expect(parse(miscRow[1].callback_data)).toEqual({ action: ACTIONS.RESET, value: 'all' });

    const closeRow = rows[rows.length - 1];
    expect(closeRow[0].text).toBe('Закрыть настройки');
    expect(parse(closeRow[0].callback_data)).toEqual({ action: ACTIONS.CLOSE, value: 'settings' });
  });

  // Test case for threshold fallback is no longer needed

});