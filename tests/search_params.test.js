import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('search params normalization and metric unification', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SEARCH_MAX_K = '20';
    process.env.SEARCH_MAX_DISTANCE = '0.7';
  });

  it('clampK clamps k to [1, SEARCH_MAX_K]', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { clampK } = mod;
    expect(clampK(0)).toBe(1);
    expect(clampK(1)).toBe(1);
    expect(clampK(5)).toBe(5);
    expect(clampK(1000)).toBe(20);
  });

  it('normalizeThreshold parses number and clamps to [0,1]', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { normalizeThreshold } = mod;
    expect(normalizeThreshold('0.9')).toBeCloseTo(0.9, 6);
    expect(normalizeThreshold(1.5)).toBe(1);
    expect(normalizeThreshold(-0.2)).toBe(0);
    expect(normalizeThreshold('not-a-number')).toBeCloseTo(0.7, 6); // default from env
  });

  it('normalizeType allows null or known types, else null', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { normalizeType } = mod;
    expect(normalizeType(null)).toBeNull();
    expect(normalizeType('short')).toBe('short');
    expect(normalizeType('stream')).toBe('stream');
    expect(normalizeType('video')).toBe('video');
    expect(normalizeType('unknown')).toBeNull();
  });

  it('ensureScoreKey maps _distance/distance to score and removes them', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { ensureScoreKey } = mod;
    const rows = [
      { id: 'a', _distance: 0.123456789 },
      { id: 'b', distance: 0.2222 },
      { id: 'c', score: 0.3333 },
      { id: 'd' },
    ];
    const out = ensureScoreKey(rows);
    expect(out[0].score).toBeCloseTo(0.123456789, 12);
    expect(out[0]._distance).toBeUndefined();
    expect(out[0].distance).toBeUndefined();

    expect(out[1].score).toBeCloseTo(0.2222, 6);
    expect(out[1]._distance).toBeUndefined();
    expect(out[1].distance).toBeUndefined();

    expect(out[2].score).toBeCloseTo(0.3333, 6);
    expect(out[3].score).toBeUndefined();
  });
});