const ACTIONS = {
  SET_TYPE: 'set_type',
  SET_THRESHOLD: 'set_threshold',
  SET_K: 'set_k',
  SET_CHANNEL: 'set_channel',
  TOGGLE: 'toggle',
  RESET: 'reset',
  CLOSE: 'close',
  NOOP: 'noop',
};

function build(action, value) {
  return value != null ? `${action}:${value}` : action;
}

function parse(data) {
  if (typeof data !== 'string' || !data.length) return { action: null, value: null };
  const [action, ...rest] = data.split(':');
  return { action, value: rest.length ? rest.join(':') : null };
}

const builders = {
  setType: (type) => build(ACTIONS.SET_TYPE, type),
  setThreshold: (delta) => build(ACTIONS.SET_THRESHOLD, delta),
  setK: (delta) => build(ACTIONS.SET_K, delta),
  setChannel: (id) => build(ACTIONS.SET_CHANNEL, String(id)),
  toggleScore: () => build(ACTIONS.TOGGLE, 'score'),
  resetAll: () => build(ACTIONS.RESET, 'all'),
  closeSettings: () => build(ACTIONS.CLOSE, 'settings'),
  noop: () => ACTIONS.NOOP,
};

module.exports = { ACTIONS, build, parse, builders };