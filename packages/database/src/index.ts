import pg from 'pg';
import type { PoolClient } from 'pg';
import { uuidSchema } from '@msm/contracts';

export const { Pool } = pg;
export type { PoolClient } from 'pg';
export async function withTenant<T>(pool: pg.Pool, tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  uuidSchema.parse(tenantId);
  const client = await pool.connect();
  let discard: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = new Error('TENANT_TRANSACTION_CLEANUP_FAILED'); }
    throw error;
  } finally { client.release(discard); }
}
