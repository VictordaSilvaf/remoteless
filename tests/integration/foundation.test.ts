import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {get} from 'node:https';
import {Pool, withTenant} from '@msm/database';
import {Vault, cryptoReady, randomKey, encode} from '@msm/crypto';
import {createApp} from '../../apps/local-api/src/app.js';
import {LocalClient} from '../../apps/desktop/src/main/client.js';

const runtime = resolve(process.env.MSM_RUNTIME_DIR ?? '.runtime');
const tenantA = randomUUID(), tenantB = randomUUID();
const groupA = randomUUID(), groupB = randomUUID();
const siteA = randomUUID(), siteB = randomUUID();
const installationId = randomUUID();
const token = 'a'.repeat(43);
let admin: InstanceType<typeof Pool>;
let pool: InstanceType<typeof Pool>;
let app: ReturnType<typeof createApp>;
const vault = new Vault();
let peer: string | undefined = 'trusted-fixture-fingerprint';
before(async () => {
  await cryptoReady();
  const config = {host: process.env.MSM_TEST_DB_HOST ?? '127.0.0.1', port: Number(process.env.MSM_TEST_DB_PORT ?? 15439), database: 'multisession', max: 2};
  admin = new Pool({...config, user: 'postgres', password: (await readFile(`${runtime}/secrets/postgres_password`, 'utf8')).trim()});
  pool = new Pool({...config, user: 'msm_app', password: (await readFile(`${runtime}/secrets/app_password`, 'utf8')).trim()});
  for (const [tenant, group, site] of [[tenantA, groupA, siteA], [tenantB, groupB, siteB]]) {
    await admin.query('INSERT INTO app.tenants(id,name) VALUES ($1,$2)', [tenant, 'Test tenant']);
    await admin.query('INSERT INTO app.groups(tenant_id,id,name) VALUES ($1,$2,$3)', [tenant, group, 'Test group']);
    await admin.query('INSERT INTO app.site_profiles(tenant_id,id,name,start_url) VALUES ($1,$2,$3,$4)', [tenant, site, 'Customer-selected site', 'https://example.org/']);
  }
  app = createApp({pool, redis: {ping: async () => 'PONG'}, vault, installation: {installationId, tenantId: tenantA, clientFingerprint: 'trusted-fixture-fingerprint', bootstrapHash: createHash('sha256').update(token).digest('hex'), bootstrapExpiresAt: new Date(Date.now() + 60_000).toISOString()}, testPeer: () => peer});
});
after(async () => {
  await app?.close();
  if (admin) {
    for (const table of ['outbox_events','audit_log','secrets','vault_verifiers','accounts','device_pairings','site_profiles','groups','tenants']) {
      await admin.query(`DELETE FROM app.${table} WHERE ${table === 'tenants' ? 'id' : 'tenant_id'} = ANY($1::uuid[])`, [[tenantA, tenantB]]);
    }
  }
  await pool?.end(); await admin?.end();
});
test('application database role has no owner, superuser or RLS bypass privileges', async () => {
  const role = await pool.query('SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user');
  assert.deepEqual(role.rows[0], {rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false});
  await assert.rejects(() => pool.query('ALTER TABLE app.groups DISABLE ROW LEVEL SECURITY'), /owner/);
  await assert.rejects(() => pool.query('TRUNCATE app.groups CASCADE'), /permission denied/);
});
test('migrations reject edited history and roll back incomplete DDL', async () => {
  const directory=await mkdtemp(resolve(tmpdir(),'msm-migrations-'));
  const original=await readFile('packages/database/migrations/001_foundation.sql','utf8');
  const invoke=()=>new Promise<{code:number;output:string}>((done,reject)=>{
    const child=spawn(process.execPath,['scripts/dist/migrate.js'],{env:{...process.env,MSM_RUNTIME_DIR:runtime,MSM_MIGRATIONS_DIR:directory,PGHOST:process.env.MSM_TEST_DB_HOST??'127.0.0.1',PGPORT:process.env.MSM_TEST_DB_PORT??'15439'},stdio:['ignore','pipe','pipe']});
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-4000);});
    child.once('error',reject);child.once('exit',code=>done({code:code??1,output}));
  });
  try {
    await writeFile(`${directory}/001_foundation.sql`,original+'\n-- changed history');
    const changed=await invoke();assert.notEqual(changed.code,0);assert.match(changed.output,/MIGRATION_CHECKSUM_MISMATCH/);
    await writeFile(`${directory}/001_foundation.sql`,original);
    await writeFile(`${directory}/002_rollback_probe.sql`,'CREATE TABLE app.phase1_rollback_probe(id integer); SELECT 1 / 0;');
    const broken=await invoke();assert.notEqual(broken.code,0);assert.match(broken.output,/division by zero/);
    assert.equal((await admin.query("SELECT to_regclass('app.phase1_rollback_probe') AS name")).rows[0].name,null);
    assert.equal((await admin.query("SELECT 1 FROM public.msm_migrations WHERE version='002_rollback_probe.sql'")).rowCount,0);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('RLS denies unscoped queries and does not leak between pool transactions', async () => {
  assert.equal((await pool.query('SELECT * FROM app.groups')).rowCount, 0);
  await withTenant(pool, tenantA, async db => {
    const result = await db.query('SELECT id FROM app.groups');
    assert.deepEqual(result.rows, [{id: groupA}]);
    assert.equal((await db.query('SELECT * FROM app.groups WHERE tenant_id=$1', [tenantB])).rowCount, 0);
    assert.equal((await db.query("UPDATE app.groups SET name='forbidden' WHERE id=$1", [groupB])).rowCount, 0);
  });
  assert.equal((await pool.query('SELECT * FROM app.groups')).rowCount, 0);
  await withTenant(pool, tenantB, async db => assert.deepEqual((await db.query('SELECT id FROM app.groups')).rows, [{id: groupB}]));
});
test('cross-tenant writes and composite references fail in PostgreSQL', async () => {
  await assert.rejects(() => withTenant(pool, tenantA, db => db.query('INSERT INTO app.groups(tenant_id,id,name) VALUES ($1,$2,$3)', [tenantB, randomUUID(), 'forbidden'])), /row-level security/);
  await assert.rejects(() => withTenant(pool, tenantA, db => db.query('INSERT INTO app.accounts(tenant_id,id,group_id,site_id,alias) VALUES ($1,$2,$3,$4,$5)', [tenantA, randomUUID(), groupB, siteA, 'cross group'])), /foreign key/);
  await assert.rejects(() => withTenant(pool, tenantA, db => db.query('INSERT INTO app.accounts(tenant_id,id,group_id,site_id,alias) VALUES ($1,$2,$3,$4,$5)', [tenantA, randomUUID(), groupA, siteB, 'cross site'])), /foreign key/);
});
test('parallel tenant transactions and a failed transaction leave no pooled tenant state', async () => {
  await Promise.all(Array.from({length:12},async(_,index)=>{
    const tenant=index%2 ? tenantA : tenantB, group=index%2 ? groupA : groupB;
    await withTenant(pool,tenant,async db=>{
      await db.query('SELECT pg_sleep(0.01)');
      assert.deepEqual((await db.query('SELECT id FROM app.groups')).rows,[{id:group}]);
    });
  }));
  await assert.rejects(()=>withTenant(pool,tenantA,async db=>{await db.query('SELECT 1 / 0');}),/division by zero/);
  assert.equal((await pool.query('SELECT * FROM app.groups')).rowCount,0);
  await withTenant(pool,tenantB,async db=>assert.deepEqual((await db.query('SELECT id FROM app.groups')).rows,[{id:groupB}]));
});
test('encrypted credentials persist without plaintext and remain tenant-scoped', async () => {
  const local = new Vault(); local.unlock(randomKey());
  const scope = {tenantId: tenantA, groupId: groupA, entityId: randomUUID(), purpose: 'credential' as const};
  const envelope = local.seal(new TextEncoder().encode('integration-secret-canary'), scope);
  const id = randomUUID();
  await withTenant(pool, tenantA, db => db.query('INSERT INTO app.secrets(tenant_id,id,group_id,entity_id,purpose,encrypted_envelope) VALUES ($1,$2,$3,$4,$5,$6)', [tenantA,id,groupA,scope.entityId,scope.purpose,envelope]));
  await withTenant(pool, tenantA, async db => {
    const row = (await db.query('SELECT encrypted_envelope FROM app.secrets WHERE id=$1', [id])).rows[0];
    assert.ok(!JSON.stringify(row).includes('integration-secret-canary'));
    assert.equal(Buffer.from(local.open(row.encrypted_envelope, scope)).toString(), 'integration-secret-canary');
  });
  await withTenant(pool, tenantB, async db => assert.equal((await db.query('SELECT * FROM app.secrets WHERE id=$1', [id])).rowCount, 0));
  local.lock();
});
test('API rejects unpaired, untrusted, browser-origin and tenant-injection requests', async () => {
  assert.equal((await app.inject({url:'/v1/foundation'})).statusCode, 401);
  peer = 'other-certificate';
  assert.equal((await app.inject({url:'/v1/session'})).statusCode, 403);
  peer = undefined;
  assert.equal((await app.inject({url:'/v1/session'})).statusCode, 401);
  peer = 'trusted-fixture-fingerprint';
  assert.equal((await app.inject({url:'/v1/session', headers:{origin:'https://evil.example'}})).statusCode, 403);
  assert.equal((await app.inject({url:'/v1/session', headers:{host:'evil.example'}})).statusCode, 403);
  assert.equal((await app.inject({method:'POST',url:'/v1/pair',payload:{installationId,bootstrapToken:token,tenantId:tenantB}})).statusCode, 400);
});
test('pairing is persisted atomically and the token cannot be consumed twice', async () => {
  const responses = await Promise.all([1,2].map(() => app.inject({method:'POST',url:'/v1/pair',payload:{installationId,bootstrapToken:token}})));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200,409]);
  const response = responses.find(response => response.statusCode === 200)!;
  assert.equal(response.json().tenantId, tenantA);
  assert.equal((await app.inject({method:'POST',url:'/v1/pair',payload:{installationId,bootstrapToken:token}})).statusCode, 409);
  assert.equal((await app.inject({url:'/v1/session'})).json().tenantId, tenantA);
});
test('readiness requires an unlocked vault and malformed requests fail as client errors', async () => {
  assert.equal((await app.inject({url:'/ready'})).statusCode, 503);
  assert.equal((await app.inject({method:'POST',url:'/v1/vault/unlock',headers:{'content-type':'application/json'},payload:'{broken-json'})).statusCode, 400);
  assert.equal((await app.inject({method:'POST',url:'/v1/vault/unlock',payload:{rootKey:'!'.repeat(44)}})).statusCode, 400);
  assert.equal((await app.inject({method:'POST',url:'/v1/vault/unlock',payload:{rootKey:'x'.repeat(30_000)}})).statusCode, 413);
});
test('vault binds the enrolled key and rejects a replacement without unlocking it', async () => {
  const key = randomKey();
  assert.equal((await app.inject({method:'POST',url:'/v1/vault/unlock',payload:{rootKey:encode(key)}})).statusCode, 200);
  assert.equal(vault.unlocked, true);
  assert.equal((await app.inject({url:'/ready'})).statusCode, 200);
  await app.inject({method:'POST',url:'/v1/vault/lock'});
  assert.equal(vault.unlocked, false);
  assert.equal((await app.inject({method:'POST',url:'/v1/vault/unlock',payload:{rootKey:encode(randomKey())}})).statusCode, 403);
  assert.equal(vault.unlocked, false);
  assert.equal((await app.inject({method:'POST',url:'/v1/vault/unlock',payload:{rootKey:encode(key)}})).statusCode, 200);
  await assert.rejects(() => withTenant(pool, tenantA, db => db.query("UPDATE app.audit_log SET verb='tampered'")), /permission denied/);
});
test('running Compose API accepts the pinned desktop client over mutual TLS', async () => {
  const client = new LocalClient(`${runtime}/client`);
  try {
    await client.initialize();
    const result = await client.connect();
    assert.ok(result.installationId);
    const status = await client.status();
    assert.equal(status.database, 'healthy'); assert.equal(status.redis, 'healthy');
  } finally {client.dispose();}
});
test('running API rejects an HTTPS client without a certificate', async () => {
  const ca = await readFile(`${runtime}/client/ca.crt`);
  await assert.rejects(() => new Promise((resolve, reject) => {
    const req = get('https://127.0.0.1:17643/v1/session', {ca, rejectUnauthorized:true}, res => {res.resume(); resolve(res.statusCode);});
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  }));
});
