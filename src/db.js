import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
`);

// failure simulation
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

function sleepSync(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {}
}

function runWithRetry(fn, maxAttempts = 5) {
  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (err) {
      attempt++;
      const isTransient = err.code === 'SQLITE_BUSY' || err.message === 'simulated_db_failure';
      if (!isTransient || attempt >= maxAttempts) {
        throw err;
      }
      const baseDelay = 10;
      const delay = Math.floor(Math.random() * (baseDelay * Math.pow(2, attempt)));
      sleepSync(delay);
    }
  }
}

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  return runWithRetry(() => {
    maybeFail();
    const stmt = db.prepare(
      'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
    );
    return stmt.run(userId, type, String(payload), idemKey || null, nowMs);
  });
}

export function getByIdemKey(idemKey) {
  return runWithRetry(() => {
    maybeFail();
    const stmt = db.prepare(
      'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?'
    );
    return stmt.get(idemKey);
  });
}

export function listSignals(userId, limit) {
  return runWithRetry(() => {
    maybeFail();
    const stmt = db.prepare(
      'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(userId, limit);
  });
}
