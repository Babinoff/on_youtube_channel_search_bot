import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { normalizeDescription } = require('../src/services/text/normalize.js');
const { env } = require('../src/config/env.js');

describe('normalizeDescription', () => {
  it('удаляет рекламные строки, обрезает по паттерну и чистит пробелы', () => {
    const prev = {
      AD: env.INDEX_DESC_AD_LINE_PREFIX_CHARS,
      STRIP: env.INDEX_DESC_STRIP_AFTER_PATTERNS,
      MAX: env.DESC_MAX_CHARS,
    };
    // Контролируемые значения окружения для детерминированности
    env.INDEX_DESC_AD_LINE_PREFIX_CHARS = '•';
    env.INDEX_DESC_STRIP_AFTER_PATTERNS = 'STOPHERE';
    env.DESC_MAX_CHARS = 1000;

    const input = [
      'Intro line',
      '• Подписывайтесь на канал',
      'Main content before STOPHERE and after',
      'STOPHERE tail that must be stripped',
    ].join('\n');

    const out = normalizeDescription(input);
    expect(out).toBe('Intro line Main content before');

    // Восстановление
    env.INDEX_DESC_AD_LINE_PREFIX_CHARS = prev.AD;
    env.INDEX_DESC_STRIP_AFTER_PATTERNS = prev.STRIP;
    env.DESC_MAX_CHARS = prev.MAX;
  });

  it('применяет ограничение по символам DESC_MAX_CHARS', () => {
    const prev = { MAX: env.DESC_MAX_CHARS, AD: env.INDEX_DESC_AD_LINE_PREFIX_CHARS, STRIP: env.INDEX_DESC_STRIP_AFTER_PATTERNS };
    env.DESC_MAX_CHARS = 5;
    env.INDEX_DESC_AD_LINE_PREFIX_CHARS = '';
    env.INDEX_DESC_STRIP_AFTER_PATTERNS = '';

    const input = 'abcdef';
    const out = normalizeDescription(input);
    expect(out).toBe('abcde');

    env.DESC_MAX_CHARS = prev.MAX;
    env.INDEX_DESC_AD_LINE_PREFIX_CHARS = prev.AD;
    env.INDEX_DESC_STRIP_AFTER_PATTERNS = prev.STRIP;
  });
});