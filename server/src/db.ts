import { Pool, type PoolClient } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://punchgrow:punchgrow_dev@localhost:5432/punchgrow',
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  statement_timeout: 10_000,
  connectionTimeoutMillis: 5_000,
});

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
