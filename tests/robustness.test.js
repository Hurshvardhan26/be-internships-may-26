import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndConsume } from '../src/rateLimit.js';
import { insertSignal, getByIdemKey } from '../src/db.js';

test('rate limit: sliding window functionality', () => {
  const userId = 'user-sliding-test';
  const start = Date.now();
  
  // Make 5 requests at start
  for (let i = 0; i < 5; i++) {
    const res = checkAndConsume(userId, start);
    assert.ok(res.ok);
    assert.equal(res.remaining, 4 - i);
  }
  
  // 6th request at the same time is rate limited
  const resLimit = checkAndConsume(userId, start);
  assert.ok(!resLimit.ok);
  assert.equal(resLimit.remaining, 0);
  assert.equal(resLimit.resetMs, start + 60_000);
  
  // A request 61 seconds later is allowed
  const resLate = checkAndConsume(userId, start + 61_000);
  assert.ok(resLate.ok);
});

test('db: transient failure retry succeeds', () => {
  // Set failure rate high but non-blocking (e.g. 0.5)
  process.env.DB_FAIL_RATE = '0.5';
  
  try {
    const t = Date.now();
    const idemKey = `idem-retry-${t}`;
    
    // insertSignal should retry internally and eventually succeed
    const info = insertSignal('user-retry', 'note', 'payload-test', idemKey, t);
    assert.ok(info.lastInsertRowid > 0);
    
    // getByIdemKey should also retry and succeed
    const row = getByIdemKey(idemKey);
    assert.ok(row);
    assert.equal(row.userId, 'user-retry');
  } finally {
    process.env.DB_FAIL_RATE = '0';
  }
});
