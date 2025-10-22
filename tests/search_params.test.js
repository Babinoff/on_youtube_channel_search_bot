import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('search params normalization and metric unification', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SEARCH_MAX_K = '20';
    process.env.SEARCH_MAX_DISTANCE = '0.7';
    // Removed MIN/MAX envs; single SOURCE OF TRUTH is SEARCH_MAX_DISTANCE
  });

  it('clampK clamps k to [1, SEARCH_MAX_K]', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { clampK } = mod;
    expect(clampK(0)).toBe(1);
    expect(clampK(1)).toBe(1);
    expect(clampK(5)).toBe(5);
    expect(clampK(1000)).toBe(20);
  });

  it('normalizeThreshold parses number or falls back to env default', async () => {
    const mod = await import('../src/services/vector/search.js');
    const { normalizeThreshold } = mod;
    expect(normalizeThreshold('0.9')).toBeCloseTo(0.9, 6);
    expect(normalizeThreshold(1.5)).toBeCloseTo(1.5, 6);
    expect(normalizeThreshold(-0.2)).toBeCloseTo(0, 6);
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