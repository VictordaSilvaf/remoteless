import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from '@msm/database';

const runtime = resolve(process.env.MSM_RUNTIME_DIR ?? '.runtime');
const secretDir = process.env.MSM_SECRET_DIR ?? `${runtime}/secrets`;
const serverDir = process.env.MSM_SERVER_DIR ?? `${runtime}/server`;
const migrationsDir = resolve(process.env.MSM_MIGRATIONS_DIR ?? 'packages/database/migrations');
const adminPassword = (await readFile(`${secretDir}/postgres_password`, 'utf8')).trim();
const appPassword = (await readFile(`${secretDir}/app_password`, 'utf8')).trim();
const installation = JSON.parse(await readFile(`${serverDir}/installation.json`, 'utf8')) as {tenantId: string};
const pool = new Pool({host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 15439), database: 'multisession', user: 'postgres', password: adminPassword, max: 1});
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('msm:migrations'))");
  const role = await client.query<{sql: string}>("SELECT format('CREATE ROLE msm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', $1::text) AS sql WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'msm_app')", [appPassword]);
  if (role.rows[0]) await client.query(role.rows[0].sql);
  const alter = await client.query<{sql: string}>("SELECT format('ALTER ROLE msm_app PASSWORD %L', $1::text) AS sql", [appPassword]);
  await client.query(alter.rows[0]!.sql);
  await client.query('CREATE TABLE IF NOT EXISTS public.msm_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(migrationsDir)).filter(n => n.endsWith('.sql')).sort()) {
    const sql = await readFile(`${migrationsDir}/${name}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = await client.query<{checksum: string}>('SELECT checksum FROM public.msm_migrations WHERE version = $1', [name]);
    if (previous.rows[0]) {
      if (previous.rows[0].checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.msm_migrations(version, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [installation.tenantId]);
  await client.query("INSERT INTO app.tenants(id, name) VALUES ($1, 'Instalação local') ON CONFLICT DO NOTHING", [installation.tenantId]);
  await client.query('COMMIT');
  console.log('Migrações aplicadas; tenant local inicializado.');
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('msm:migrations'))");
  client.release();
  await pool.end();
}
