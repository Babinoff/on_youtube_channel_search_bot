import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { toVideoEntity } = require('../src/services/youtube/video.js');

describe('toVideoEntity', () => {
  it('формирует сущность видео: id, url, очищенный title, raw description, publishedAt', () => {
    const v = {
      id: 'abc123',
      snippet: {
        title: '  Hello   world  ',
        description: 'original desc',
        publishedAt: '2020-01-01T00:00:00Z',
        liveBroadcastContent: 'none',
      },
      contentDetails: { duration: 'PT0M40S' },
    };

    const entity = toVideoEntity(v);
    expect(entity.id).toBe('abc123');
    expect(entity.url).toBe('https://youtu.be/abc123');
    expect(entity.title).toBe('Hello world');
    expect(entity.description).toBe('original desc');
    expect(entity.publishedAt).toBe('2020-01-01T00:00:00Z');
  });

  it('deriveType: short при продолжительности <= SHORTS_MAX_SECONDS', () => {
    const v = {
      id: 'v1',
      snippet: { title: 'Short video', description: '', liveBroadcastContent: 'none' },
      contentDetails: { duration: 'PT0M45S' },
    };
    const entity = toVideoEntity(v);
    expect(entity.type).toBe('short');
  });

  it('deriveType: stream при признаках трансляции', () => {
    const v = {
      id: 'v2',
      snippet: { title: 'Live now', description: '', liveBroadcastContent: 'live' },
      contentDetails: { duration: 'PT1H10M00S' },
      liveStreamingDetails: { actualStartTime: '2023-05-05T10:00:00Z' },
    };
    const entity = toVideoEntity(v);
    expect(entity.type).toBe('stream');
  });
});