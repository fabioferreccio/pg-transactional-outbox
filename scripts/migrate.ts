/**
 * Migration CLI
 * 
 * Uses 'pg' driver by default to run migrations.
 */
import pg from 'pg';
import { runMigrations } from '../src/scripts/run-migrations.js';
import { PgSqlExecutor } from '../src/adapters/persistence/pg-executor.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://outbox:outbox_secret@localhost:5432/outbox';
const PARTITION_TABLES = process.env.PARTITION_TABLES === 'true';
const ENABLE_AUDIT = process.env.ENABLE_AUDIT === 'true';

async function main() {
  console.log('🐘 Local Migration: Connecting to database...');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const executor = new PgSqlExecutor(client);
      
      await runMigrations(executor, {
        partitionTables: PARTITION_TABLES,
        enableAudit: ENABLE_AUDIT
      });

      await client.query('COMMIT');
      console.log('✅ Migration complete!');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
