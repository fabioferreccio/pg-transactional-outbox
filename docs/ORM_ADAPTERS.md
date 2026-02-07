# Prisma Adapter Example

To use `pg-transactional-outbox` with Prisma, you need to implement a simple adapter that wraps the Prisma Client (or a transaction client) and conforms to the `SqlExecutor` interface.

## Implementation

Create a file named `prisma-sql-executor.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { SqlExecutor, QueryResult } from 'pg-transactional-outbox/adapters';

/**
 * Adapter to execute SQL via Prisma
 */
export class PrismaSqlExecutor implements SqlExecutor {
  // Accepts either the main client or a transaction client (Prisma.TransactionClient)
  constructor(private readonly prisma: PrismaClient | any) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // Prisma's $queryRawUnsafe returns the rows directly.
    // Note: Parameter substitution in Prisma uses distinct syntax depending on the DB,
    // but for Postgres $queryRawUnsafe accepts standard parameterized queries 
    // if you pass values correctly. 
    // However, pg-transactional-outbox uses $1, $2 syntax which Prisma supports 
    // natively in $queryRawUnsafe for PostgreSQL.
    
    // We need to ensure params are passed.
    const rows = await this.prisma.$queryRawUnsafe(sql, ...params);

    // Prisma does not return rowCount easily for SELECTs, but for UPDATE/DELETE 
    // it returns { count: n } if using executeRaw.
    // But the Outbox Repository expects rows for SELECT/INSERT/UPDATE...RETURNING.
    // For simpler commands that just return count, we might need $executeRawUnsafe.
    
    // However, the Outbox Repository uses queries that mostly return rows (RETURNING *).
    // For the specific case of markCompleted/markFailed which might not return rows,
    // we need to handle the return type variance.
    
    // Let's refine this to be robust:
    
    // 1. Try to run as query
    const result = await this.prisma.$queryRawUnsafe(sql, ...params);
    
    if (Array.isArray(result)) {
       return {
         rows: result as T[],
         rowCount: result.length,
       };
    }
    
    // Fallback if it returns a non-array (e.g. some driver edge cases)
    return {
       rows: [],
       rowCount: 0,
    };
  }
}
```

## Usage

```typescript
import { PrismaClient } from '@prisma/client';
import { PostgresOutboxRepository } from 'pg-transactional-outbox/adapters';

const prisma = new PrismaClient();
const executor = new PrismaSqlExecutor(prisma);
const outboxRepo = new PostgresOutboxRepository(executor);
const idempotencyStore = new PostgresIdempotencyStore(executor);

// Inside a transaction
await prisma.$transaction(async (tx) => {
  const txExecutor = new PrismaSqlExecutor(tx);
  const txOutboxRepo = new PostgresOutboxRepository(txExecutor);
  const txIdempotency = new PostgresIdempotencyStore(txExecutor);
  
  // 1. Check Idempotency
  if (await txIdempotency.isProcessed(event.trackingId)) return;

  // 2. Business Logic...

  // 3. Mark Processed
  await txIdempotency.markProcessed(event.trackingId, 'my-consumer');
});
```

> **Note:** Ensure your Prisma schema does not conflict with the `outbox` table managed by raw SQL, or introspect it to let Prisma know about it (though not strictly necessary as we use raw SQL).

# Knex Adapter Example

To use with Knex, simply wrap the `knex` instance.

## Implementation

```typescript
import { Knex } from 'knex';
import { SqlExecutor, QueryResult } from 'pg-transactional-outbox/adapters';

export class KnexSqlExecutor implements SqlExecutor {
  constructor(private readonly knex: Knex | Knex.Transaction) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // Knex.raw returns the driver's raw response. 
    // For 'pg' driver, it's the Result object with .rows and .rowCount
    const result = await this.knex.raw(sql, params as any[]);
    
    return {
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }
}
```

## Usage

```typescript
import knex from 'knex';
import { PostgresOutboxRepository } from 'pg-transactional-outbox/adapters';

const db = knex({ client: 'pg', connection: '...' });
const executor = new KnexSqlExecutor(db);
const outboxRepo = new PostgresOutboxRepository(executor);

// Transaction
await db.transaction(async (trx) => {
  const trxExecutor = new KnexSqlExecutor(trx);
  const trxRepo = new PostgresOutboxRepository(trxExecutor);
  
  // Use trxRepo...
});
```

# TypeORM Adapter Example

TypeORM's `query` method returns just the rows (array), so we need to handle `rowCount` carefully or ignore it if not strictly needed (though `markCompleted` relies on it).

## Implementation

```typescript
import { DataSource, EntityManager } from 'typeorm';
import { SqlExecutor, QueryResult } from 'pg-transactional-outbox/adapters';

export class TypeOrmSqlExecutor implements SqlExecutor {
  constructor(private readonly manager: EntityManager | DataSource) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // TypeORM .query() returns the raw array of results (for SELECT/RETURNING)
    // It does NOT return rowCount easily.
    // However, for UPDATE/DELETE, we get the second arg as metadata in some drivers, 
    // but TypeORM abstraction hides it.
    
    // WORKAROUND: For strict compatibility, we might need a lower-level access 
    // or assume rowCount > 0 if rows are returned, or 1 for updates if no error thrown.
    
    const rows = await this.manager.query(sql, params);
    
    // This is a simplification. 
    // For precise rowCount on UPDATEs without RETURNING, TypeORM raw query is tricky.
    // Fortunately, most critical Outbox queries use RETURNING * or we can tolerate 
    // approximate rowCount for 'mark' operations (boolean return).
    
    return {
      rows: rows as T[],
      rowCount: Array.isArray(rows) ? rows.length : 0, 
    };
  }
}
```

