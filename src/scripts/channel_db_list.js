require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { env } = require("../config/env");
const { connectDb } = require("../services/vector/lancedb");

function getDbDir() {
  return env.LANCEDB_DIR || "./data/lancedb";
}

async function listTables() {
  const dir = getDbDir();
  try {
    const db = await connectDb();
    const entries = fs.readdirSync(dir).filter((e) => {
      const full = path.join(dir, e);
      try {
        return fs.statSync(full).isDirectory() && e.startsWith("video_embeddings_");
      } catch {
        return false;
      }
    });

    if (!entries.length) {
      console.log("Таблицы каналов не найдены.");
      return;
    }

    for (const name of entries.sort()) {
      let rows = "?";
      try {
        const table = await db.openTable(name);
        const qb = table.query().select(["id"]);
        const res = await qb.toArray();
        rows = Array.isArray(res) ? res.length : "?";
      } catch (e) {
        rows = "?";
      }
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      const modified = stat.mtime?.toISOString?.() || String(stat.mtime);
      console.log(`${name} | rows: ${rows} | modified: ${modified}`);
    }
  } catch (err) {
    console.error("Ошибка чтения каталога LanceDB:", err.message);
    process.exit(1);
  }
}

listTables();