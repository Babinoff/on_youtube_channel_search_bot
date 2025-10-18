require("dotenv").config();
const { logger } = require("../config/logger");
const { isLocked, readLockInfo, releaseLock, isProcessAlive, isLockStale } = require("../services/concurrency/lock");

async function main() {
  const name = process.argv[2] || "indexing";
  const forceFlag = process.argv.includes("--force") || process.argv.includes("--yes");

  const locked = await isLocked(name);
  if (!locked) {
    console.log(`lock '${name}': already free`);
    return;
  }
  const info = await readLockInfo(name);
  const pid = info?.pid;
  const alive = isProcessAlive(pid);
  const stale = await isLockStale(name, { maxAgeMs: 120000 });

  if (alive && !forceFlag) {
    console.error(`lock '${name}': held by alive pid ${pid}. Use --force to unlock.`);
    process.exit(2);
  }
  if (!stale && !forceFlag) {
    console.error(`lock '${name}': not stale (last update ${info?.updatedAt}). Use --force to unlock anyway.`);
    process.exit(3);
  }

  const ok = await releaseLock(name);
  if (ok) {
    console.log(`lock '${name}': force unlocked`);
    logger.warn({ name, pid, alive, stale }, "force unlocked lock file");
  } else {
    console.error(`lock '${name}': cannot delete (already free?)`);
    process.exit(4);
  }
}

main().catch((err) => {
  logger.error({ err: err?.message || err }, "lock force error");
  process.exit(1);
});