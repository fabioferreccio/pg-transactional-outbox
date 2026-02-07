/**
 * Migration Logic
 *
 * Executes the database migration.
 * Can be used by any runner (pg, Knex context, etc.)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SqlExecutor } from "../adapters/persistence/sql-executor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MigrationConfig {
  partitionTables?: boolean;
  enableAudit?: boolean;
}

export async function runMigrations(
  executor: SqlExecutor,
  config: MigrationConfig = {},
) {
  const { partitionTables = false, enableAudit = false } = config;

  // 1. Select Schema
  // We need to resolve from src/scripts to docs/
  // ../../docs
  const schemaFile = partitionTables
    ? "outbox-schema.sql"
    : "outbox-schema-simple.sql";

  const docsDir = path.resolve(__dirname, "../../docs");
  const schemaPath = path.join(docsDir, schemaFile);

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at: ${schemaPath}`);
  }

  console.log(
    `📦 Applying Schema: ${schemaFile} (Partitioning: ${partitionTables})`,
  );
  const schemaSql = fs.readFileSync(schemaPath, "utf-8");
  await executor.query(schemaSql);

  // 2. Optional: Audit
  if (enableAudit) {
    console.log("🕵️ Enabling Audit Infrastructure...");
    const auditPath = path.join(docsDir, "audit-infrastructure.sql");
    if (!fs.existsSync(auditPath)) {
      throw new Error(`Audit file not found at: ${auditPath}`);
    }
    const auditSql = fs.readFileSync(auditPath, "utf-8");
    await executor.query(auditSql);
  }
}
