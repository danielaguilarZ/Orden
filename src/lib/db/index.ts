import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { migrations } from "./migrations";

/**
 * Base de datos SQLite compartida entre la web (Next.js) y el worker.
 * Modo WAL: varios procesos leen mientras uno escribe.
 */

type Db = DatabaseSync;

const globalForDb = globalThis as unknown as { __ordenDb?: Db; __ordenDbPath?: string };

export function dbPath(): string {
  return path.resolve(process.env.ORDEN_DB_PATH ?? path.join(process.cwd(), "data", "orden.db"));
}

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

export function getDb(): Db {
  const file = dbPath();
  if (!globalForDb.__ordenDb || globalForDb.__ordenDbPath !== file) {
    globalForDb.__ordenDb = openDb(file);
    globalForDb.__ordenDbPath = file;
  }
  return globalForDb.__ordenDb;
}

/** Sustituye la BD global (para tests). */
export function setDbForTests(db: Db) {
  globalForDb.__ordenDb = db;
  globalForDb.__ordenDbPath = dbPath();
}

export function migrate(db: Db) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (const m of migrations) {
    if (m.version <= version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Otro proceso pudo migrar mientras esperábamos el bloqueo.
      const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (current < m.version) {
        m.up(db);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.exec("COMMIT");
      version = m.version;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function tx<T>(fn: () => T): T {
  const db = getDb();
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
