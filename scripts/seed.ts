/**
 * Simple Seed Script
 * 
 * Fills the database with initial test data.
 */
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://outbox:outbox_secret@localhost:5432/outbox';

async function seed() {
  console.log('🌱 Seeding database...');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  
  try {
    // Add dummy data if needed
    console.log('✅ Seeding complete (No-op for now)!');
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
