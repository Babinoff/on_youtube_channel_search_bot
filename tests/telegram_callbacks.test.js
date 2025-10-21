import { describe, it, expect } from 'vitest';
import { ACTIONS, parse, build, builders } from '../src/services/telegram/callbacks';

describe('telegram callbacks', () => {
  it('parse handles action:value and action only', () => {
    expect(parse('set_type:short')).toEqual({ action: ACTIONS.SET_TYPE, value: 'short' });
    expect(parse('noop')).toEqual({ action: ACTIONS.NOOP, value: null });
    expect(parse('reset:all')).toEqual({ action: ACTIONS.RESET, value: 'all' });
    expect(parse('set_channel:UC123')).toEqual({ action: ACTIONS.SET_CHANNEL, value: 'UC123' });
    expect(parse('unknown:thing:with:colons')).toEqual({ action: 'unknown', value: 'thing:with:colons' });
  });

  it('builders produce consistent callback_data', () => {
    expect(builders.setType('video')).toBe('set_type:video');
    expect(builders.setK('-5')).toBe('set_k:-5');
    expect(builders.setChannel('UC999')).toBe('set_channel:UC999');
    expect(builders.toggleScore()).toBe('toggle:score');
    expect(builders.resetAll()).toBe('reset:all');
    expect(builders.closeSettings()).toBe('close:settings');
    expect(builders.noop()).toBe(ACTIONS.NOOP);
  });

  it('build utility composes callback_data strings', () => {
    expect(build(ACTIONS.RESET, 'all')).toBe('reset:all');
    expect(build(ACTIONS.NOOP)).toBe('noop');
  });
});