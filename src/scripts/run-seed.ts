/**
 * Seed Logic
 *
 * Populates the database with initial data.
 */
import { SqlExecutor } from "../adapters/persistence/sql-executor.js";

export async function runSeed(executor: SqlExecutor) {
  console.log("🌱 Seeding database logic...");

  // Example seed logic:
  // await executor.query('INSERT INTO ...');

  console.log("✅ Seeding complete!");
}
