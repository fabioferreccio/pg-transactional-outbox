# Enterprise Observability Guide

This guide documents the complete observability, audit, and telemetry infrastructure for the Transactional Outbox pattern.

## Architecture Overview

```mermaid
flowchart TB
    subgraph Application
        APP[Application Code]
        OTEL[OTel Instrumentation]
    end
    
    subgraph PostgreSQL
        OUTBOX[(Outbox Table)]
        AUDIT[(Audit Log)]
        WAL[WAL Stream]
    end
    
    subgraph CDC
        DEBEZIUM[Debezium]
        KAFKA[Kafka]
    end
    
    subgraph Observability
        PROM[Prometheus]
        GRAFANA[Grafana]
        JAEGER[Jaeger/Tempo]
    end
    
    APP --> |trace context| OTEL
    APP --> |INSERT| OUTBOX
    OUTBOX --> |trigger| AUDIT
    OUTBOX --> |CDC| DEBEZIUM
    DEBEZIUM --> KAFKA
    
    OUTBOX --> |metrics| PROM
    PROM --> GRAFANA
    OTEL --> JAEGER
```

---

## 1. OpenTelemetry Integration

### Setup

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

### Instrumentation

```typescript
import { 
  withOutboxInsertSpan, 
  instrumentOutboxInsert 
} from './otel-instrumentation';

// Automatically inject trace context into events
const event = instrumentOutboxInsert({
  tracking_id: crypto.randomUUID(),
  aggregate_id: order.id,
  aggregate_type: 'Order',
  event_type: 'OrderCreated',
  payload: order,
});
```

### Trace Propagation Flow

| Component | Action |
|-----------|--------|
| **Producer** | Inject `trace_id`, `span_id` into `metadata` |
| **Database** | Store context with event |
| **Worker** | Extract context, create child span |
| **Consumer** | Continue trace with linked spans |

📄 **Reference**: [otel-instrumentation.ts](file:///c:/Users/fabio/_WORKER_/Personal/pg-transactional-outbox/.agent/skills/transactional-outbox-architect/examples/otel-instrumentation.ts)

---

## 2. PostgreSQL Metrics

### postgres_exporter Setup

```bash
docker run -d \
  -e DATA_SOURCE_NAME="postgresql://user:pass@host:5432/db?sslmode=disable" \
  -e PG_EXPORTER_EXTEND_QUERY_PATH=/queries.yaml \
  -v ./postgres-exporter-queries.yaml:/queries.yaml \
  -p 9187:9187 \
  prometheuscommunity/postgres-exporter
```

### Key Metrics

| Metric | Purpose | Alert Threshold |
|--------|---------|-----------------|
| `pg_outbox_pending_depth_pending_count` | Queue depth | > 10,000 |
| `pg_outbox_oldest_event_oldest_pending_seconds` | Staleness | > 300s |
| `pg_outbox_latency_p95_latency_seconds` | Processing time | > 30s |
| `pg_outbox_bloat_dead_tuples` | Table health | > 100,000 |
| `pg_outbox_replication_lag_lag_bytes` | CDC health | > 100MB |

📄 **Reference**: [postgres-exporter-queries.yaml](file:///c:/Users/fabio/_WORKER_/Personal/pg-transactional-outbox/.agent/skills/transactional-outbox-architect/resources/postgres-exporter-queries.yaml)

---

## 3. Audit Infrastructure

### pgAudit (Compliance)

```sql
-- Enable in postgresql.conf
shared_preload_libraries = 'pgaudit'
pgaudit.log = 'write, ddl'
pgaudit.log_parameter = on
```

### Trigger-Based Audit (Data Changes)

```sql
-- Captures old/new values in JSONB
CREATE TRIGGER trg_outbox_audit
  AFTER INSERT OR UPDATE OR DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION fn_outbox_audit();
```

### Gap Detection

```sql
-- Find sequence gaps (potential data loss)
SELECT * FROM fn_detect_outbox_gaps_by_date(
  NOW() - INTERVAL '24 hours'
);
```

📄 **Reference**: [audit-infrastructure.sql](file:///c:/Users/fabio/_WORKER_/Personal/pg-transactional-outbox/.agent/skills/transactional-outbox-architect/resources/audit-infrastructure.sql)

---

## 4. Autovacuum Tuning

High-throughput outbox tables require aggressive vacuum:

```sql
ALTER TABLE outbox SET (
  autovacuum_vacuum_scale_factor = 0.01,  -- 1% instead of 20%
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_limit = 2000,
  autovacuum_vacuum_cost_delay = 2
);
```

### Health Check

```sql
SELECT * FROM fn_check_outbox_vacuum_health();

-- Returns: live_tuples, dead_tuples, dead_ratio, vacuum_needed
```

---

## 5. Alerting Strategy

### Severity Levels

| Level | Response SLA | Examples |
|-------|-------------|----------|
| **P1 Critical** | 15 min | Queue stalled, CDC down |
| **P2 High** | 1 hour | Backlog high, DLE spike |
| **P3 Medium** | 4 hours | Throughput drop |
| **P4 Low** | Next day | DLE present, table large |

### Key Alerts

```yaml
# Queue completely stalled
- alert: OutboxQueueStalled
  expr: pg_outbox_oldest_event_oldest_pending_seconds > 300
  for: 2m
  labels:
    severity: critical

# Dead letter spike
- alert: OutboxDeadLetterSpike
  expr: increase(pg_outbox_dead_letter_total[5m]) > 10
  labels:
    severity: high
```

📄 **Reference**: [prometheus-alerting-rules.yaml](file:///c:/Users/fabio/_WORKER_/Personal/pg-transactional-outbox/.agent/skills/transactional-outbox-architect/resources/prometheus-alerting-rules.yaml)

---

## 6. Grafana Dashboard

Import the unified dashboard for complete visibility:

```bash
# Import via Grafana API
curl -X POST \
  -H "Content-Type: application/json" \
  -d @grafana-dashboard.json \
  http://admin:admin@grafana:3000/api/dashboards/db
```

### Panels

| Section | Metrics |
|---------|---------|
| **Key Metrics** | Pending, oldest age, DLE, P95 latency |
| **Throughput** | Events/sec, insert vs complete rate |
| **Queue Status** | By status, stale events |
| **PostgreSQL** | Tuples, bloat %, table size, vacuum status |
| **CDC** | Replication lag, slot status |

📄 **Reference**: [grafana-dashboard.json](file:///c:/Users/fabio/_WORKER_/Personal/pg-transactional-outbox/.agent/skills/transactional-outbox-architect/resources/grafana-dashboard.json)

---

## 7. WAL Direct Emission (Advanced)

For ultra-high-throughput (>50K events/sec):

```sql
-- Bypass outbox table, emit directly to WAL
PERFORM pg_logical_emit_message(
  true,                    -- transactional
  'outbox.Order.Created',  -- prefix
  event_json::TEXT
);
```

### Benefits

| Aspect | Table-Based | WAL-Direct |
|--------|-------------|------------|
| Bloat | Yes (requires vacuum) | None |
| Lock contention | Possible | None |
| Latency | ~10ms | ~1ms |
| Queryable | Yes | No |

📄 **Reference**: [wal-direct-emit.sql](file:///c:/Users/fabio/_WORKER_/Personal/pg-transactional-outbox/.agent/skills/transactional-outbox-architect/resources/wal-direct-emit.sql)

---

## 8. Compliance Views

### GDPR Data Subject Access

```sql
SELECT * FROM v_outbox_data_subject_access
WHERE aggregate_id = 'user-uuid';
-- Returns payload with PII redacted
```

### SOX Audit Trail

```sql
SELECT * FROM v_outbox_sox_audit
WHERE audit_date >= '2024-01-01';
-- Returns operation counts by day
```

### HIPAA Access Log

```sql
SELECT * FROM v_outbox_hipaa_access_log
WHERE phi_flag = 'PHI ACCESSED';
-- Returns access records with PHI flag
```

---

## Quick Start Checklist

- [ ] Deploy postgres_exporter with custom queries
- [ ] Import Grafana dashboard
- [ ] Configure Prometheus alerting rules
- [ ] Apply autovacuum tuning to outbox table
- [ ] Enable pgAudit or trigger-based audit
- [ ] Add OpenTelemetry instrumentation
- [ ] Schedule gap detection audits
- [ ] Configure CDC replication slot monitoring
