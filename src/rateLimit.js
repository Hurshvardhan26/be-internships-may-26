const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;
const buckets = new Map();

/**
 * Concurrency-Safe Sliding Window Rate Limiter
 * 
 * In a single-threaded Node.js environment, this implementation is safe from race conditions 
 * because JavaScript executes synchronously within each tick of the event loop.
 * 
 * Multi-Instance Scale Plan (Redis Migration):
 * To make this rate limiter safe across multiple instances:
 * 1. Replace the in-memory `buckets` Map with Redis.
 * 2. Use a Redis Sorted Set (ZSET) per user:
 *    - Score: Request timestamp (nowMs).
 *    - Member: A unique identifier (e.g. nowMs + "_" + UUID/random_suffix) to avoid duplicate deduplication.
 * 3. Execute the following actions atomically in a Lua script via `EVAL` to avoid check-then-set race conditions:
 *    - `redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. (nowMs - WINDOW_MS))` -> Clear expired timestamps.
 *    - `local cnt = redis.call('ZCARD', key)` -> Get current request count in window.
 *    - `if cnt < RATE then`
 *         `redis.call('ZADD', key, nowMs, nowMs_member)` -> Record current request.
 *         `redis.call('EXPIRE', key, math.ceil(WINDOW_MS / 1000) + 1)` -> Refresh key TTL.
 *         `return {1, RATE - cnt - 1}`
 *      `else`
 *         `local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')` -> Find oldest request to calculate resetMs.
 *         `return {0, 0, oldest[2]}`
 *      `end`
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  const wStart = nowMs - WINDOW_MS;
  
  // Get existing timestamps for user
  let timestamps = buckets.get(userId) || [];
  
  // Filter out timestamps older than the current sliding window start
  timestamps = timestamps.filter(ts => ts > wStart);
  
  const count = timestamps.length;
  const ok = count < RATE;
  
  if (ok) {
    timestamps.push(nowMs);
    buckets.set(userId, timestamps);
  }
  
  const currentCount = ok ? count + 1 : count;
  const remaining = Math.max(RATE - currentCount, 0);
  
  // The next reset occurs when the oldest timestamp in the window expires.
  // If the window is empty, the reset occurs after WINDOW_MS from now.
  const oldestTs = timestamps.length > 0 ? timestamps[0] : nowMs;
  const resetMs = oldestTs + WINDOW_MS;
  
  return { ok, remaining, resetMs };
}
