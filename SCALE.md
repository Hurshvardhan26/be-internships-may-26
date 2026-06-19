# Scale Plan (10k RPS)

## Data model/indexes
- **Database:** Migrate from SQLite to a distributed SQL cluster (e.g., PostgreSQL / Amazon Aurora Serverless).
- **Schema & Indexes:**
  - Keep `idempotency_key` with a `UNIQUE` constraint.
  - Optimize the list query index: `CREATE INDEX idx_user_created ON signals(user_id, created_at DESC)`.
- **Connection Pooling:** Use `PgBouncer` to multiplex connections and prevent connection exhaustion from thousands of parallel Node.js tasks.

## Idempotency across instances
- **Fast-Path (Redis Cache):** Write the result of successful requests to Redis with a TTL of 24-48 hours. Keys are formatted as `idem:{idempotency_key}`. Concurrent incoming requests check Redis first.
- **Atomic Database Guard (SQL Unique Constraint):** Fall back to the SQL `UNIQUE` constraint on `idempotency_key`. If Redis cache misses and two concurrent requests insert to PostgreSQL, one will fail the unique constraint. The failed transaction intercepts this and fetches the record created by the successful concurrent transaction.

## Rate limiting across instances
- **Technology:** Distributed Redis cluster.
- **Algorithm:** Sliding window rate limiting.
- **Implementation:** Execute an atomic Redis Lua script per request using Sorted Sets (ZSET) for each user:
  1. Remove expired timestamps: `ZREMRANGEBYSCORE key -inf (now - window)`.
  2. Count items: `ZCARD key`.
  3. If count is below limits, register request: `ZADD key now unique_uuid` and `EXPIRE key window_ttl`.
  4. If over limits, return the score of the oldest member via `ZRANGE key 0 0 WITHSCORES` to compute the retry reset time.

## Observability (logs/metrics/alerts)
- **Structured Logging:** Use `pino` (high-performance JSON logger) to log request metadata, omitting sensitive payloads.
- **Metrics (Prometheus & Grafana):** Track HTTP request rate, latency histograms, error rates (5xx/429), DB query performance, and Redis hit/miss ratios.
- **Alerting:** Set up PagerDuty alerts for elevated 5xx error rates (>1%), high rate-limit drop ratios, database connection pool exhaustion, and elevated request latencies.

## Failure modes (DB down / partial outages / retries)
- **DB Outage / Saturation:** Implement a circuit breaker (e.g., `opossum`) to fast-fail DB operations when failure rates exceed 20%, returning 503 instantly to protect downstream services.
- **Retries with Jitter:** Continue retrying transient errors using exponential backoff with full jitter to avoid "thundering herd" problems.
- **Asynchronous Queue ingestion:** For high-throughput signal ingestion where real-time read consistency isn't strictly required, decouple the API layer from writes by putting signals onto a message queue (Kafka / RabbitMQ / SQS) and consuming them asynchronously.

## 10k RPS design sketch (infra & cost ballpark)
- **API Nodes:** ~25 ECS Fargate tasks (2 vCPU, 4GB RAM) scaled horizontally via an Application Load Balancer.
- **In-Memory Store (Redis):** AWS ElastiCache for Redis (Cluster Mode Enabled) with 3 shards (primary + replica per shard, `cache.m6g.xlarge` instance type) to easily handle 10k read/write RPS.
- **Database:** Amazon Aurora PostgreSQL (1 primary `db.r6g.4xlarge` + 2 read replicas `db.r6g.4xlarge` with auto-scaling).
- **Cost Estimate (Monthly):**
  - Compute (ECS Fargate): ~$1,200
  - Redis Cluster: ~$1,000
  - Aurora DB Cluster: ~$3,500
  - Load Balancers & Network/Data Transfer: ~$1,500
  - **Total Estimated Cost:** ~$7,200 / month.
