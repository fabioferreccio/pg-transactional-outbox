# High-Scale Partitioning & Auditing

For high-volume production environments, `pg-transactional-outbox` supports **Table Partitioning** (via `pg_partman`) and **Trigger-based Auditing**.

## 🚀 Partitioning Setup

Partitioning splits the `outbox` table into smaller, time-based chunks (e.g., daily or weekly). This keeps indexes small and queries fast, even with millions of events.

### Prerequisites
1.  **PostgreSQL 14+**
2.  **`pg_partman` extension** installed on the database.

### Enabling Partitioning
When running the migration, set the `PARTITION_TABLES` environment variable:

```bash
PARTITION_TABLES=true npm run db:migrate
```

This will:
1.  Create the `outbox` table using `PARTITION BY RANGE`.
2.  Initialize `partman.create_parent` to manage child partitions automatically.

### ⚠️ Maintenance (Critical)
Partitioning requires a periodic maintenance job to create future partitions. If you don't run this, inserts will fail when they reach a date for which no partition exists.

**Method A: `pg_cron` (Recommended)**
If you have `pg_cron` installed, schedule the maintenance directly in the DB:

```sql
SELECT cron.schedule('@hourly', $$CALL partman.run_maintenance_proc()$$);
```

**Method B: External Cron (Linux/K8s)**
Run this command periodically (e.g., hourly):

```bash
psql "$DATABASE_URL" -c "CALL partman.run_maintenance_proc()"
```

---

## 🕵️ Auditing Setup

To enable a tamper-evident audit log of all changes to the `outbox` (inserts, updates, deletes), you can enable the Audit Infrastructure.

### Enabling Audit
When running migration:

```bash
ENABLE_AUDIT=true npm run db:migrate
```

This will:
1.  Create `outbox_audit_log` table.
2.  Attach triggers to `outbox` to record every change.
3.  Create compliance views (`v_outbox_sox_audit`, etc.).

### Viewing Audit Logs
You can query the audit log directly or use the provided views:

```sql
-- Who changed event X?
SELECT * FROM outbox_audit_log WHERE event_id = 12345;

-- Daily operation summary (SOX view)
SELECT * FROM v_outbox_sox_audit;
```
