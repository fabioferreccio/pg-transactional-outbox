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
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │  Service    │──▶ │  Outbox     │──▶│   Worker    │      │
│  │  (writes)   │    │  (table)    │    │  (relay)    │      │
│  └─────────────┘    └─────────────┘    └─────────────┘      │
│         │                  │                  │             │
│         ▼                  ▼                  ▼             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                     PostgreSQL                        │  │
│  │   Same Transaction = Atomicity Guarantee              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────┐
                    │ External System │
                    │ (Kafka, SNS...) │
                    └─────────────────┘
```

## ⚠️ Ordering Guarantees

> [!WARNING]
> This library does **NOT** guarantee global event ordering.

**Event order is NOT preserved when:**
- Multiple workers are running (parallelism > 1)
- Events fail and are retried (retry reorders the queue)
- Network partitions cause lease expirations

**If strict ordering is required:**
1. Use single worker mode (`concurrency: 1`)
2. Implement consumer-side ordering (e.g., sequence numbers per aggregate)
3. Consider a partition-aware design (one worker per aggregate)

The library logs a warning when `concurrency > 1` to remind operators of this behavior.

## 📦 Installation

### Via npm (Recommended)

```bash
npm install pg-transactional-outbox
```

### Via Git (Private/Forked)

```bash
npm install git+ssh://git@github.com:fabioferreccio/pg-transactional-outbox.git

# or
npm install github:fabioferreccio/pg-transactional-outbox --force

# Or switch to a specific tag
npm install github:fabioferreccio/pg-transactional-outbox#v0.6.6
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

---

## 📤 Producer (Publishing Events)

The **Producer** is your application code that **inserts events into the outbox table** within the same transaction that modifies business state.

```typescript
import { Pool } from 'pg';
import { PublishEventUseCase, PostgresOutboxRepository } from 'pg-transactional-outbox';

// 1. Configure database connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 2. Create repository and use case instances
const repository = new PostgresOutboxRepository(pool);
const publishUseCase = new PublishEventUseCase(repository);

// 3. Publish event (INSIDE the business transaction!)
async function createOrder(customerId: string, total: number) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // a) Create order (business state)
    const orderId = crypto.randomUUID();
    await client.query(
      'INSERT INTO orders (id, customer_id, total) VALUES ($1, $2, $3)',
      [orderId, customerId, total]
    );
    
    // b) Publish event in the same transaction!
    const txRepository = new PostgresOutboxRepository(client);
    const txPublishUseCase = new PublishEventUseCase(txRepository);
    
    await txPublishUseCase.execute({
      aggregateId: orderId,
      aggregateType: 'Order',
      eventType: 'OrderCreated',
      payload: { orderId, customerId, total, createdAt: new Date() },
    });
    
    await client.query('COMMIT');
    return orderId;
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

> [!IMPORTANT]
> The event **MUST** be inserted in the **same transaction** as the business state. This guarantees atomicity: either both are persisted, or neither.

---

## ⚙️ Worker (Event Relay)

The **Worker** is a background process that **relays (forwards)** events from the outbox to external systems (Kafka, RabbitMQ, HTTP webhooks, etc.).

### What the Worker does:

1. **Poll**: Fetches `PENDING` events from the outbox table
2. **Claim**: Acquires a "lease" (temporary lock) on the events
3. **Process**: Sends each event to the external system
4. **Complete/Fail**: Marks as `COMPLETED` or `FAILED`
5. **Repeat**: Goes back to step 1

```typescript
import { Pool } from 'pg';
import { 
  ProcessOutboxUseCase, 
  PostgresOutboxRepository 
} from 'pg-transactional-outbox';

// 1. Configure connection and repository
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const repository = new PostgresOutboxRepository(pool);

// 2. Create the processing use case
const processOutbox = new ProcessOutboxUseCase(repository);

// 3. Implement the handler that sends events to the external system
async function publishToKafka(event: OutboxEvent): Promise<void> {
  // Example: send to Kafka
  await kafkaProducer.send({
    topic: `${event.aggregateType}.${event.eventType}`,
    messages: [{ 
      key: event.aggregateId, 
      value: JSON.stringify(event.payload) 
    }],
  });
}

// 4. Worker loop
async function startWorker() {
  console.log('🚀 Worker started');
  
  while (true) {
    try {
      // Fetch and process batch of events
      const result = await processOutbox.execute({
        batchSize: 100,
        leaseSeconds: 30,
        handler: publishToKafka,  // your send function
      });
      
      console.log(`✅ Processed: ${result.processed}, ❌ Failed: ${result.failed}`);
      
    } catch (error) {
      console.error('Worker error:', error);
    }
    
    // Interval between polls
    await sleep(1000);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start
startWorker();
```

> [!TIP]
> The Worker does **NOT** process business logic - it only **transmits** events to external systems. Business logic belongs in the **Consumer**.

---

## 📥 Consumer (Processing Events)

The **Consumer** is the code that **receives and processes** events from the external system (Kafka, RabbitMQ, etc.). This is where the receiver's business logic happens.

```typescript
import { Pool } from 'pg';
import { PostgresIdempotencyStore } from 'pg-transactional-outbox';

// 1. Configure idempotency store
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const idempotencyStore = new PostgresIdempotencyStore(pool);

// 2. Consumer handler (called by Kafka/RabbitMQ/etc)
async function handleOrderCreated(event: OrderCreatedEvent) {
  const { trackingId, payload } = event;
  
  // a) ALWAYS check if already processed (idempotency!)
  if (await idempotencyStore.isProcessed(trackingId)) {
    console.log(`⏭️ Event ${trackingId} already processed, skipping`);
    return;
  }
  
  // b) Process business logic
  await sendConfirmationEmail(payload.customerId, payload.orderId);
  await updateInventory(payload.items);
  await notifyWarehouse(payload.orderId);
  
  // c) Mark as processed (prevents future duplicates)
  await idempotencyStore.markProcessed(trackingId, 'order-consumer');
  
  console.log(`✅ Event ${trackingId} processed successfully`);
}

// 3. Connect to Kafka/RabbitMQ
kafkaConsumer.subscribe({ topic: 'Order.OrderCreated' });

kafkaConsumer.run({
  eachMessage: async ({ message }) => {
    const event = JSON.parse(message.value.toString());
    await handleOrderCreated(event);
  },
});
```

> [!CAUTION]
> **Idempotency is MANDATORY!** This is an at-least-once delivery system. Events may be delivered more than once (network failures, retries, etc). Your consumer MUST check for duplicates.

## 🔌 Using with ORMs (Prisma, Knex, etc.)

This library is **driver-agnostic**. You can use it with **Prisma**, **Knex**, **TypeORM**, or any other tool by implementing the simple `SqlExecutor` interface.

### Example: Prisma

```typescript
// 1. Create a simple adapter
const prismaExecutor = {
  async query(sql: string, params: any[]) {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return { rows, rowCount: rows.length };
  }
};

// 2. Inject into Repository & Idempotency Store
const repository = new PostgresOutboxRepository(prismaExecutor);
const idempotencyStore = new PostgresIdempotencyStore(prismaExecutor);

// 3. Use inside Prisma Transaction
await prisma.$transaction(async (tx) => {
  const txAdapter = { /* wrapper */ };
  const txRepo = new PostgresOutboxRepository(txAdapter);
  const txIdempotency = new PostgresIdempotencyStore(txAdapter);

  // Check idempotency first!
  if (await txIdempotency.isProcessed(eventId)) return;

  // Process...
  
  // Mark processed
  await txIdempotency.markProcessed(eventId, 'consumer-group');
});
```

👉 **[See Full Adapter Guide](docs/ORM_ADAPTERS.md)** for Knex, TypeORM, and production-ready code.



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
  // 1. Initialize Deduplication Store (supports SqlExecutor!)
  const idempotencyStore = new PostgresIdempotencyStore(poolOrExecutor);

  // 2. Check if already processed
  if (await idempotencyStore.isProcessed(event.trackingId)) {
    return;  // Skip duplicate
  }
  
  // 3. Process event
  await sendEmail(event.payload.customerId);
  
  // 4. Mark as processed (atomically if possible)
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

# Migration Flags (npm run db:migrate):
PARTITION_TABLES=true     # Enable pg_partman
ENABLE_AUDIT=true         # Enable audit triggers
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
| [High Scale & Audit](docs/PARTITIONING.md) | Partitioning (pg_partman) & Auditing |

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
