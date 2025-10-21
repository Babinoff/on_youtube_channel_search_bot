import { describe, it, expect } from 'vitest';

// Pure unit tests for applyOrderingForLatest to avoid HTTP and env

describe('applyOrderingForLatest', () => {
  it('filters by type before slice(k): returns first k shorts', async () => {
    const mod = await import('../src/services/youtube/latest.js');
    const { applyOrderingForLatest } = mod;

    const mapped = [
      { id: 'vshort1', type: 'short' },
      { id: 'vstream', type: 'stream' },
      { id: 'vvideo', type: 'video' },
      { id: 'vshort2', type: 'short' },
    ];

    const res = applyOrderingForLatest(mapped, 2, 'short');
    const ids = res.map((x) => x.id);
    expect(ids).toEqual(['vshort1', 'vshort2']);
  });

  it('returns first k with no type filter', async () => {
    const mod = await import('../src/services/youtube/latest.js');
    const { applyOrderingForLatest } = mod;

    const mapped = [
      { id: 'vshort1', type: 'short' },
      { id: 'vstream', type: 'stream' },
      { id: 'vvideo', type: 'video' },
      { id: 'vshort2', type: 'short' },
    ];

    const res = applyOrderingForLatest(mapped, 3, null);
    const ids = res.map((x) => x.id);
    expect(ids).toEqual(['vshort1', 'vstream', 'vvideo']);
  });
});