import { Pool, PoolClient } from "pg";
import { SqlExecutor, QueryResult } from "./sql-executor.js";

/**
 * PostgreSQL Executor (Default)
 *
 * Wraps pg.Pool or pg.PoolClient to implement SqlExecutor.
 */
export class PgSqlExecutor implements SqlExecutor {
  constructor(private readonly client: Pool | PoolClient) {}

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }
}
