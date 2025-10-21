import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { normalizeQueryText } = require('../src/services/text/query_normalize.js');

describe('normalizeQueryText', () => {
  it('очищает пунктуацию, приводит к нижнему регистру и заменяет ё→е', () => {
    const s = normalizeQueryText('  Warhammer — Ёжик, Абаддон!  ');
    expect(s).toBe('warhammer ежик абаддон');
  });

  it('наивно приводит русские падежи к основе', () => {
    expect(normalizeQueryText('Абаддона')).toBe('абаддон');
    expect(normalizeQueryText('Разорителя')).toBe('разорител');
    expect(normalizeQueryText('Легионам')).toBe('легион');
  });

  it('упрощает английские формы', () => {
    expect(normalizeQueryText('videos')).toBe('video');
    expect(normalizeQueryText('indexed')).toBe('index');
    expect(normalizeQueryText('running')).toBe('run');
  });

  it('дедуплицирует токены и сохраняет порядок первых вхождений', () => {
    const s = normalizeQueryText('Абаддон Абаддона Абаддон');
    expect(s).toBe('абаддон');
  });
});