import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { Pool } from '@msm/database';
import { Vault, cryptoReady } from '@msm/crypto';
import { createApp, type Installation } from './app.js';
import {LabClient} from '../../session-lab/src/client.js';

await cryptoReady();
const runtime = resolve(process.env.MSM_RUNTIME_DIR ?? '.runtime');
const serverDir = process.env.MSM_SERVER_DIR ?? `${runtime}/server`;
const secretDir = process.env.MSM_SECRET_DIR ?? `${runtime}/secrets`;
const installation = JSON.parse(await readFile(`${serverDir}/installation.json`, 'utf8')) as Installation;
let lab:LabClient|undefined;
try{const config=JSON.parse(await readFile(`${serverDir}/lab.json`,'utf8')) as {tenantId:string;capability:string};if(config.tenantId!==installation.tenantId)throw Error('LAB_TENANT_MISMATCH');lab=new LabClient('/run/msm/lab/control.sock',config.capability);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const pool = new Pool({host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 15439), database: 'multisession', user: 'msm_app', password: (await readFile(`${secretDir}/app_password`, 'utf8')).trim(), max: 8, connectionTimeoutMillis: 3000, statement_timeout: 5000});
pool.on('error', () => {});
const redis = new Redis({host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 16379), password: (await readFile(`${secretDir}/redis_password`, 'utf8')).trim(), maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true});
redis.on('error', () => {});
const app = createApp({pool, redis, vault: new Vault(), installation,lab,maxAccounts:Number(process.env.MSM_MAX_ACCOUNTS??500),proxyProbeUrl:process.env.MSM_PROXY_PROBE_URL??'https://api64.ipify.org?format=json', https: {
  key: await readFile(`${serverDir}/server.key`), cert: await readFile(`${serverDir}/server.crt`), ca: await readFile(`${serverDir}/ca.crt`), requestCert: true, rejectUnauthorized: true,
}});
await pool.query('SELECT 1');
await redis.connect();
await redis.ping();
app.addHook('onClose', async () => { redis.disconnect(); await pool.end(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
await app.listen({host: process.env.MSM_BIND ?? '127.0.0.1', port: Number(process.env.MSM_PORT ?? 17643)});
