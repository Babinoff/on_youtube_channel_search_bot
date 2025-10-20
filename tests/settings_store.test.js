import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { env } from '../src/config/env';
import { getUserSettings, updateUserSettings, resetUserSettings } from '../src/services/user/settings_store';

const USERS_DIR = path.resolve(process.cwd(), 'data', 'users');
const TEST_USER_ID = 'vitest_settings_user';
const USER_FILE = path.join(USERS_DIR, `${TEST_USER_ID}.json`);

describe('settings_store normalization', () => {
  beforeAll(() => {
    // Ensure clean state
    try { fs.unlinkSync(USER_FILE); } catch {}
  });

  afterAll(() => {
    // Cleanup test user file
    try { fs.unlinkSync(USER_FILE); } catch {}
  });

  it('clamps k to [1..SEARCH_MAX_K]', () => {
    const maxK = Number(env.SEARCH_MAX_K || 20);

    updateUserSettings(TEST_USER_ID, { k: maxK + 100 });
    let s = getUserSettings(TEST_USER_ID);
    expect(s.k).toBe(maxK);

    updateUserSettings(TEST_USER_ID, { k: 0 });
    s = getUserSettings(TEST_USER_ID);
    expect(s.k).toBe(1);

    updateUserSettings(TEST_USER_ID, { k: 'not a number' });
    s = getUserSettings(TEST_USER_ID);
    expect(s.k).toBeGreaterThanOrEqual(1);
    expect(s.k).toBeLessThanOrEqual(maxK);
  });

  it('coerces threshold to a numeric value (falls back to default)', () => {
    const defaultThreshold = (typeof env.SEARCH_MAX_DISTANCE === 'number')
      ? env.SEARCH_MAX_DISTANCE
      : parseFloat(env.SEARCH_MAX_DISTANCE) || 0.75;

    updateUserSettings(TEST_USER_ID, { threshold: 'not-a-number' });
    let s = getUserSettings(TEST_USER_ID);
    expect(typeof s.threshold).toBe('number');
    // Allow small rounding differences
    expect(Math.abs(s.threshold - defaultThreshold)).toBeLessThan(1e-6);

    updateUserSettings(TEST_USER_ID, { threshold: 1.23 });
    s = getUserSettings(TEST_USER_ID);
    expect(s.threshold).toBeCloseTo(1.23, 6);
  });

  it('sanitizes type to one of short|stream|video or null', () => {
    updateUserSettings(TEST_USER_ID, { type: 'invalid' });
    let s = getUserSettings(TEST_USER_ID);
    expect(s.type).toBeNull();

    updateUserSettings(TEST_USER_ID, { type: 'short' });
    s = getUserSettings(TEST_USER_ID);
    expect(s.type).toBe('short');

    updateUserSettings(TEST_USER_ID, { type: 'stream' });
    s = getUserSettings(TEST_USER_ID);
    expect(s.type).toBe('stream');

    updateUserSettings(TEST_USER_ID, { type: 'video' });
    s = getUserSettings(TEST_USER_ID);
    expect(s.type).toBe('video');
  });

  it('coerces showScore to boolean and sanitizes channelId', () => {
    updateUserSettings(TEST_USER_ID, { showScore: 0, channelId: '' });
    let s = getUserSettings(TEST_USER_ID);
    expect(s.showScore).toBe(false);
    expect(s.channelId).toBeNull();

    updateUserSettings(TEST_USER_ID, { showScore: 1, channelId: 'UC123' });
    s = getUserSettings(TEST_USER_ID);
    expect(s.showScore).toBe(true);
    expect(s.channelId).toBe('UC123');
  });

  it('defaultSettings are normalized', () => {
    const s = resetUserSettings(TEST_USER_ID);
    const maxK = Number(env.SEARCH_MAX_K || 20);
    expect(typeof s.threshold).toBe('number');
    expect(s.k).toBeGreaterThanOrEqual(1);
    expect(s.k).toBeLessThanOrEqual(maxK);
    expect([null, 'short', 'stream', 'video']).toContain(s.type);
    expect(typeof s.showScore).toBe('boolean');
  });
});