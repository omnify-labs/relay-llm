/**
 * Postgres database client.
 * Connects to Postgres for usage logging and budget queries.
 */

import postgres from 'postgres';

let sql: ReturnType<typeof postgres> | null = null;

/**
 * Get or create the Postgres connection.
 * Uses DATABASE_URL environment variable.
 */
export function getDb(): ReturnType<typeof postgres> {
  if (!sql) {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error(
        '[Relay] DATABASE_URL is not set. Set it to your Postgres connection string.',
      );
    }

    sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
    });

    console.log('[Relay] Postgres connected');
  }

  return sql;
}
