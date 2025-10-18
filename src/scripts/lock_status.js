require("dotenv").config();
const { logger } = require("../config/logger");
const { isLocked, readLockInfo, isProcessAlive, isLockStale } = require("../services/concurrency/lock");

async function main() {
  const name = process.argv[2] || "indexing";
  const locked = await isLocked(name);
  if (!locked) {
    console.log(`lock '${name}': free`);
    return;
  }
  const info = await readLockInfo(name);
  const stage = info?.meta?.stage;
  const total = info?.meta?.total;
  const current = info?.meta?.current;
  const startedAt = info?.startedAt;
  const updatedAt = info?.updatedAt;
  const pid = info?.pid;
  const alive = isProcessAlive(pid);
  const ageMs = updatedAt ? (Date.now() - new Date(updatedAt).getTime()) : NaN;
  const stale = await isLockStale(name, { maxAgeMs: 120000 });

  const progress = typeof current === 'number' && typeof total === 'number' ? `${current}/${total}` : "";
  console.log([
    `lock '${name}': held`,
    `pid=${pid} alive=${alive}`,
    `stage=${stage || "?"}${progress ? ` (${progress})` : ""}`,
    `startedAt=${startedAt || "?"}`,
    `updatedAt=${updatedAt || "?"}`,
    `ageMs=${Number.isFinite(ageMs) ? ageMs : "?"}`,
    `stale=${stale}`,
  ].join(" | "));
  logger.info({ name, stage, current, total, startedAt, updatedAt, pid, alive, ageMs, stale }, "lock status");
}

main().catch((err) => {
  logger.error({ err: err?.message || err }, "lock status error");
  process.exit(1);
});