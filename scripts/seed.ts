/**
 * Seed CLI
 * 
 * Uses 'pg' driver by default to seed database.
 */
import pg from 'pg';
import { runSeed } from '../src/scripts/run-seed.js';
import { PgSqlExecutor } from '../src/adapters/persistence/pg-executor.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://outbox:outbox_secret@localhost:5432/outbox';

async function main() {
  console.log('🌱 Seeding database...');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const executor = new PgSqlExecutor(client);
      
      await runSeed(executor);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
