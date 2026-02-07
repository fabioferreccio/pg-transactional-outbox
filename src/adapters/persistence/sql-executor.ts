/**
 * SQL Executor Interface
 *
 * Abstracts the database driver execution to allow compatibility with
 * different ORMs (Prisma, TypeORM, Knex) and drivers.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}
