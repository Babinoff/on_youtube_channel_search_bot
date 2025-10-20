import { describe, it, expect } from 'vitest';
import { formatSearchItem } from '../src/services/telegram/format';

describe('formatSearchItem', () => {
  it('formats with index, url, date, type and six-decimal score', () => {
    const text = formatSearchItem({
      index: 1,
      title: 'Sample Video',
      id: 'abc123',
      url: '',
      score: 0.123456789,
      published_at: '2024-01-02T00:00:00Z',
      type: 'short',
      description_indexed: 'desc',
    });

    expect(text.split('\n')[0]).toBe('1. Sample Video');
    expect(text).toContain('https://youtu.be/abc123');
    expect(text).toContain('score: 0.123457');
    expect(text).toContain('date: 2024-01-02');
    expect(text).toContain('type: short');
  });

  it('omits score when undefined', () => {
    const text = formatSearchItem({
      index: 2,
      title: 'No Score',
      id: 'def456',
      url: '',
      score: undefined,
      published_at: '2024-01-03',
      type: 'video',
      description_indexed: '',
    });

    expect(text.split('\n')[0]).toBe('2. No Score');
    expect(text).toContain('https://youtu.be/def456');
    expect(text).toContain('date: 2024-01-03');
    expect(text).toContain('type: video');
    expect(text).not.toContain('score:');
  });
});