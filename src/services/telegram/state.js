const pendingInputs = new Map();

function setPendingInput(userId, state) {
  pendingInputs.set(userId, state);
}

function getPendingInput(userId) {
  return pendingInputs.get(userId);
}

function clearPendingInput(userId) {
  pendingInputs.delete(userId);
}

function hasPendingInput(userId) {
  return pendingInputs.has(userId);
}

module.exports = { setPendingInput, getPendingInput, clearPendingInput, hasPendingInput };