import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.SEARCH_MAX_K = '20';
  process.env.SEARCH_MAX_DISTANCE = '0.7';
  // Removed MIN/MAX; only SEARCH_MAX_DISTANCE is authoritative
});

describe('search normalization + score formatting', () => {
  it('clamps k to env SEARCH_MAX_K', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { clampK } = mod;
    expect(clampK(1)).toBe(1);
    expect(clampK(50)).toBe(20);
    expect(clampK('not-a-number')).toBe(1);
  });

  it('normalizes threshold by parsing or using env default', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { normalizeThreshold } = mod;
    expect(normalizeThreshold(-5)).toBeCloseTo(0, 6);
    expect(normalizeThreshold(2.3)).toBeCloseTo(2.3, 6);
    expect(normalizeThreshold('not-a-number')).toBeCloseTo(0.7, 6);
  });

  it('normalizes type and rejects unknown types', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { normalizeType } = mod;
    expect(normalizeType('short')).toBe('short');
    expect(normalizeType('stream')).toBe('stream');
    expect(normalizeType('video')).toBe('video');
    expect(normalizeType('unknown')).toBeNull();
    expect(normalizeType(null)).toBeNull();
  });

  it('ensureScoreKey maps _distance/distance to score', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { ensureScoreKey } = mod;
    const rows = [
      { id: 'a', _distance: 0.5, title: 'A' },
      { id: 'b', distance: 0.42, title: 'B' },
      { id: 'c', score: 0.9, title: 'C' },
      { id: 'd', title: 'D' },
    ];
    const out = ensureScoreKey(rows);
    expect(out[0].score).toBeCloseTo(0.5, 6);
    expect(out[1].score).toBeCloseTo(0.42, 6);
    expect(out[2].score).toBeCloseTo(0.9, 6);
    expect(out[3].score).toBeUndefined();
  });
});