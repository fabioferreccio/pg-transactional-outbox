# PostgreSQL Transactional Outbox

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-blue.svg)](https://www.postgresql.org/)

> **Production-grade Transactional Outbox Framework** for guaranteed event delivery with PostgreSQL.

### 📚 Documentação / Documentation
- [📖 **Manual de Uso (Português)**](docs/USAGE_GUIDE.md)
- [📖 **Architecture Reference (English)**](#🏗️-architecture)

## 🎯 Why Transactional Outbox?

### The Dual-Write Problem

```
❌ WRONG: Two separate writes that can fail independently

BEGIN;
  INSERT INTO orders (...);  -- ✅ Succeeds
COMMIT;

await kafka.publish(event);  -- ❌ Fails (network error)
-- Result: Order created, but no event published!
```

### The Outbox Solution

```
✅ RIGHT: Single atomic transaction

BEGIN;
  INSERT INTO orders (...);       -- Business state
  INSERT INTO outbox (...);       -- Event (same TX!)
COMMIT;

-- Worker picks up and publishes later
-- Even if Kafka is down, event is durably stored
```

## 🏗️ Architecture

This framework implements the **Transactional Outbox Pattern** with:

- **At-Least-Once Delivery**: Events are guaranteed to be published
- **Idempotency Contract**: Consumers MUST handle duplicates
- **Lease/Heartbeat**: Prevents zombie workers
- **Reaper Process**: Recovers stale events
- **Dead Letter Events (DLE)**: Isolates poison messages

```
┌─────────────────────────────────────────────────────────────┐
│                     APPLICATION                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Service   │───▶│   Outbox    │───▶│   Worker    │     │
│  │  (writes)   │    │  (table)    │    │  (relay)    │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│         │                  │                  │             │
│         ▼                  ▼                  ▼             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                     PostgreSQL                        │ │
│  │   Same Transaction = Atomicity Guarantee              │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────┐
                    │ External System │
                    │ (Kafka, SNS...) │
                    └─────────────────┘
```

## 📦 Installation

### Via npm (Recommended)

```bash
npm install pg-transactional-outbox
```

### Via Git (Private/Forked)

```bash
npm install git+ssh://git@github.com:fabioferreccio/pg-transactional-outbox.git
# or
npm install git+https://github.com/fabioferreccio/pg-transactional-outbox.git
```

## 🚀 Release Workflow

To publish a new version (creates git tag & updates package.json):

```bash
# 1. Patch (0.0.X) - Bug fixes
npm run release:patch

# 2. Minor (0.X.0) - New features (backward compatible)
npm run release:minor

# 3. Major (X.0.0) - Breaking changes
npm run release:major
```

## 🚀 Quick Start

### 1. Setup PostgreSQL

```bash
# Start PostgreSQL with optimized settings
docker-compose up -d
```

### 2. Create the Outbox Table (Day 0 Partitioning)

```sql
-- ⚠️ MANDATORY: Table MUST be partitioned from Day 0
CREATE TABLE outbox (
  id              BIGSERIAL,
  tracking_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  aggregate_id    UUID NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'PENDING',
  retry_count     INT NOT NULL DEFAULT 0,
  max_retries     INT NOT NULL DEFAULT 5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  locked_until    TIMESTAMPTZ,
  lock_token      BIGINT,
  last_error      TEXT,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions (pg_partman recommended for automation)
CREATE TABLE outbox_2024_02 PARTITION OF outbox
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
```

### 3. Publish Events (In Same Transaction)

```typescript
import { Pool } from 'pg';
import { PublishEventUseCase, PostgresOutboxRepository } from 'pg-transactional-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Inside your business transaction
await pool.query('BEGIN');

// 1. Create order (business state)
await pool.query('INSERT INTO orders (id, customer_id, total) VALUES ($1, $2, $3)', 
  [orderId, customerId, total]);

// 2. Publish event (SAME transaction!)
const publishUseCase = new PublishEventUseCase(new PostgresOutboxRepository(pool));
await publishUseCase.execute({
  aggregateId: orderId,
  aggregateType: 'Order',
  eventType: 'OrderCreated',
  payload: { orderId, customerId, total },
});

await pool.query('COMMIT');
```

## ⚙️ Resilience Mechanisms

### Lease / Heartbeat

Events are "leased" to workers for a limited time:

```sql
-- Worker claims events with a lease
UPDATE outbox 
SET status = 'PROCESSING', 
    locked_until = NOW() + INTERVAL '30 seconds',
    lock_token = $1
WHERE status = 'PENDING'
  AND (locked_until IS NULL OR locked_until < NOW())
LIMIT 100
FOR UPDATE SKIP LOCKED
RETURNING *;
```

Workers MUST renew the lease while processing:

```typescript
// Heartbeat every 10 seconds during long operations
const heartbeat = setInterval(async () => {
  await repository.renewLease(eventId, lockToken, 30);
}, 10_000);
```

### Reaper

A background process recovers events "stuck" in PROCESSING:

```sql
-- Reaper query: recover stale events
UPDATE outbox
SET status = 'PENDING',
    locked_until = NULL,
    lock_token = NULL
WHERE status = 'PROCESSING'
  AND locked_until < NOW();  -- lease expired
```

**Rules:**
- Reaper MUST run every `lease_seconds / 2`
- Reaper recovers events with expired leases
- Prevents "zombie workers" from blocking events

### Dead Letter Events (DLE)

Events that fail repeatedly are isolated:

```typescript
// After max retries, event goes to DLE
if (event.retryCount >= event.maxRetries) {
  await repository.markDeadLetter(eventId, lockToken, error);
}
```

**DLE Governance:**
- ✅ Redrive with RCA (Root Cause Analysis) required
- ⛔ Blind redrive is PROHIBITED
- 📊 Monitor DLE count as critical metric

## 📋 Consumer Contract (MANDATORY)

### ⚠️ Idempotency is NOT Optional

**Every consumer MUST implement deduplication:**

```typescript
// ❌ WRONG: No idempotency check
async function handleOrderCreated(event: OrderCreatedEvent) {
  await sendEmail(event.payload.customerId);  // May send twice!
}

// ✅ RIGHT: Idempotent consumer
async function handleOrderCreated(event: OrderCreatedEvent) {
  // Check if already processed
  if (await idempotencyStore.isProcessed(event.trackingId)) {
    return;  // Skip duplicate
  }
  
  // Process event
  await sendEmail(event.payload.customerId);
  
  // Mark as processed (atomically with side effect if possible)
  await idempotencyStore.markProcessed(event.trackingId, 'email-service');
}
```

**Why is this mandatory?**
- This is an **at-least-once** delivery system
- Network failures, retries, and Reaper can cause duplicates
- Without idempotency, you WILL process events multiple times

## 📊 Partitioning Strategy (Day 0)

### Why Partition from Day 0?

```
❌ Problem without partitioning:
- Table grows unbounded
- Vacuum becomes slower over time
- Queries scan entire table
- No way to efficiently archive old data

✅ Solution with partitioning:
- Fast partition pruning on queries
- Independent vacuum per partition
- Easy archival via DETACH
- Bounded data per partition
```

### Retention Tiers

| Tier | Age | Location | Purpose |
|------|-----|----------|---------|
| Hot | 0-7 days | Primary DB | Active processing |
| Warm | 7-90 days | Primary DB | Debugging, audits |
| Cold | 90+ days | Object Storage | Compliance |
| Archived | 1+ year | Glacier/Archive | Legal retention |

### Automated Partition Management

```sql
-- Using pg_partman
SELECT partman.create_parent(
  'public.outbox',
  'created_at',
  'native',
  'daily'
);

-- Enable automatic creation + retention
UPDATE partman.part_config
SET retention = '90 days',
    retention_keep_table = false
WHERE parent_table = 'public.outbox';
```

## 🔧 Configuration

### PostgreSQL Tuning (docker-compose.yml)

```yaml
command:
  # WAL: Reduce checkpoint frequency
  - "-c" 
  - "max_wal_size=2GB"
  - "-c"
  - "checkpoint_timeout=15min"
  
  # Autovacuum: Aggressive for high-churn tables
  - "-c"
  - "autovacuum_vacuum_scale_factor=0.01"  # 1% instead of 20%
  - "-c"
  - "autovacuum_vacuum_cost_limit=2000"
  
  # Logical replication for CDC
  - "-c"
  - "wal_level=logical"
```

### Environment Variables

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/outbox
OUTBOX_BATCH_SIZE=100
OUTBOX_LEASE_SECONDS=30
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_MAX_RETRIES=5
```

## 📈 Scale Ceiling

| Throughput | Approach |
|------------|----------|
| < 1,000/s | Single worker, polling |
| 1,000 - 10,000/s | Multiple workers, SKIP LOCKED |
| 10,000 - 50,000/s | pg_notify, aggressive tuning |
| > 50,000/s | **Migrate to Kafka via CDC** |

> ⚠️ **PostgreSQL is not a message broker.** At high scale, use Debezium CDC to stream changes to Kafka.

## 🏛️ Project Structure

```
src/
├── core/                    # Hexagonal core (no dependencies)
│   ├── domain/              # Entities, Value Objects
│   │   ├── entities/
│   │   │   └── outbox-event.ts
│   │   ├── value-objects/
│   │   │   ├── event-status.ts
│   │   │   └── trace-context.ts
│   │   ├── events/
│   │   └── errors/
│   ├── ports/               # Interfaces (driven/driver)
│   │   ├── outbox-repository.port.ts
│   │   ├── event-publisher.port.ts
│   │   └── idempotency-store.port.ts
│   └── use-cases/           # Application services
│       ├── publish-event.use-case.ts
│       ├── process-outbox.use-case.ts
│       └── reap-stale-events.use-case.ts
├── adapters/                # External implementations
│   └── persistence/
│       ├── postgres-outbox.repository.ts
│       └── postgres-idempotency.store.ts
└── main/                    # Composition root
    └── index.ts
```

## 📚 Resources

### Operational Runbooks

| Document | Purpose |
|----------|---------|
| [DLE Runbook](docs/dle-runbook.md) | Dead Letter handling procedures |
| [Capacity Model](docs/capacity-model.md) | Scale formulas and tuning |
| [Incident Playbook](docs/incident-playbook.md) | Symptom → Action mapping |
| [Migration Roadmap](docs/migration-roadmap.md) | Kafka/CDC migration guide |

### Observability

| Document | Purpose |
|----------|---------|
| [Observability Guide](docs/observability-guide.md) | Full setup documentation |
| [Grafana Dashboard](docs/grafana-dashboard.json) | Import into Grafana |
| [Prometheus Alerts](docs/prometheus-alerting-rules.yaml) | P1-P4 alerting rules |

## 📜 License

MIT © 2024

## 🤝 Contributing

Contributions are welcome! Please read the contributing guidelines first.

---

> **Remember:** This is NOT a message broker. It's a pattern for guaranteed event delivery using PostgreSQL as the source of truth.
