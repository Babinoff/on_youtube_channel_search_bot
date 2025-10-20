import { test, expect } from 'vitest';
import adminRouter from '../src/services/admin/router.js';

const { extractArgs } = adminRouter;

test('extractArgs: returns empty array when no args', () => {
  const tokens = extractArgs('/lock_status', 'lock_status');
  expect(tokens).toEqual([]);
});

test('extractArgs: parses positional and flag args', () => {
  const tokens = extractArgs('/lock_force indexing --force', 'lock_force');
  expect(tokens).toEqual(['indexing', '--force']);
});

test('extractArgs: supports quoted values', () => {
  const tokens = extractArgs("/channel_db_delete 'UCxxxx' --yes", 'channel_db_delete');
  expect(tokens).toEqual(['UCxxxx', '--yes']);
});

test('extractArgs: splits flags and values', () => {
  const tokens = extractArgs('/index_batch --limit 100 --stop-on-first-known on', 'index_batch');
  expect(tokens).toEqual(['--limit', '100', '--stop-on-first-known', 'on']);
});