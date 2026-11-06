import Fastify, { LogController } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { ZodError } from 'zod';
import { PROTOCOL_VERSION, pairRequestSchema, vaultUnlockSchema, type FoundationStatus } from '@msm/contracts';
import { Vault, decode, wipe } from '@msm/crypto';
import type { Ciphertext } from '@msm/contracts';
import { withTenant, type Pool } from '@msm/database';
import {labCommandSchema,uuidSchema} from '@msm/contracts';
import type {LabClient} from '../../session-lab/src/client.js';
import {WorkspaceService} from './workspace/service.js';
import {WorkspaceError} from './workspace/errors.js';
import type {NetworkPolicy} from './workspace/network.js';

export interface Installation {
  installationId: string; tenantId: string; clientFingerprint: string;
  bootstrapHash: string; bootstrapExpiresAt: string;
}
export interface Dependencies {
  pool: InstanceType<typeof Pool>;
  redis: {ping(): Promise<string>};
  vault: Vault;
  installation: Installation;
  lab?:LabClient;
  maxAccounts?:number;
  workspaceNetwork?:NetworkPolicy;
  proxyProbeUrl?:string;
  https?: {key: Buffer; cert: Buffer; ca: Buffer; requestCert: boolean; rejectUnauthorized: boolean};
  /** Only supplied by in-process tests. Production always reads the TLS socket. */
  testPeer?: () => string | undefined;
}
class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export function createApp(deps: Dependencies) {
  const app = Fastify({
    ...(deps.https ? {https: deps.https} : {}),
    logger: {level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers.set-cookie'], serializers: {req: req => ({method: req.method, url: req.url?.split('?')[0]})}},
    bodyLimit: 16 * 1024, requestTimeout: 30_000, connectionTimeout: 30_000,
    logController: new LogController({disableRequestLogging: true}),
  });
  const {installation: identity, pool} = deps;
  const workspace=new WorkspaceService({pool,vault:deps.vault,tenantId:identity.tenantId,actorId:identity.installationId,...(deps.maxAccounts===undefined?{}:{maxAccounts:deps.maxAccounts}),...(deps.workspaceNetwork?{network:deps.workspaceNetwork}:{}),...(deps.proxyProbeUrl?{probeUrl:deps.proxyProbeUrl}:{})});
  let windowStart = Date.now();
  let requests = 0;
  let frameWindow=Date.now(),frameRequests=0;
  const paired = () => withTenant(pool, identity.tenantId, async db => {
    const result = await db.query('SELECT 1 FROM app.device_pairings WHERE id = $1 AND certificate_fingerprint = $2', [identity.installationId, identity.clientFingerprint]);
    return result.rowCount === 1;
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const socket = request.raw.socket as TLSSocket;
    const peer = deps.testPeer ? deps.testPeer() : socket.authorized ? socket.getPeerCertificate().fingerprint256 : undefined;
    if (!peer) throw new HttpError(401, 'CLIENT_CERTIFICATE_REQUIRED');
    if (request.url === '/status') return;
    if (request.headers.origin !== undefined) throw new HttpError(403, 'BROWSER_ORIGIN_FORBIDDEN');
    const host = request.headers.host?.split(':')[0];
    if (!['127.0.0.1', 'localhost', 'api'].includes(host ?? '')) throw new HttpError(403, 'HOST_FORBIDDEN');
    if (peer !== identity.clientFingerprint) throw new HttpError(403, 'INSTALLATION_FORBIDDEN');
    if(request.url.startsWith('/v1/lab/frame/')||request.url==='/v1/lab/status'){
      if(Date.now()-frameWindow>1000){frameWindow=Date.now();frameRequests=0;}
      if(++frameRequests>40)throw new HttpError(429,'RATE_LIMITED');
    }else{
      if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 120) throw new HttpError(429, 'RATE_LIMITED');
    }
    if (request.url !== '/v1/pair' && !await paired()) throw new HttpError(401, 'INSTALLATION_NOT_PAIRED');
  });
  app.get('/status', async () => ({status: 'ok', protocolVersion: PROTOCOL_VERSION}));
  app.post('/v1/pair', async request => {
    const body = pairRequestSchema.parse(request.body);
    const supplied = Buffer.from(createHash('sha256').update(body.bootstrapToken).digest('hex'), 'hex');
    const expected = Buffer.from(identity.bootstrapHash, 'hex');
    if (body.installationId !== identity.installationId || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || Date.parse(identity.bootstrapExpiresAt) <= Date.now()) throw new HttpError(403, 'PAIRING_REJECTED');
    return withTenant(pool, identity.tenantId, async db => {
      const row = await db.query('INSERT INTO app.device_pairings(tenant_id, id, certificate_fingerprint) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [identity.tenantId, identity.installationId, identity.clientFingerprint]);
      if (!row.rowCount) throw new HttpError(409, 'INSTALLATION_ALREADY_PAIRED');
      await db.query('INSERT INTO app.audit_log(tenant_id,id,actor_id,verb,target_id,request_id) VALUES ($1,$2,$3,$4,$3,$5)', [identity.tenantId, randomUUID(), identity.installationId, 'installation.paired', request.id]);
      return {installationId: identity.installationId, tenantId: identity.tenantId, protocolVersion: PROTOCOL_VERSION};
    });
  });
  app.get('/v1/session', async () => ({installationId: identity.installationId, tenantId: identity.tenantId, protocolVersion: PROTOCOL_VERSION}));
  app.post('/v1/workspace/command',{bodyLimit:1_048_576},request=>workspace.run(request.body,request.id));
  const lab=()=>{if(!deps.lab)throw new HttpError(503,'LAB_UNAVAILABLE');return deps.lab;};
  app.get('/v1/lab/status',()=>lab().status());
  app.post('/v1/lab/command',request=>lab().command(labCommandSchema.parse(request.body)));
  app.get('/v1/lab/frame/:accountId',request=>lab().frame(uuidSchema.parse((request.params as {accountId:string}).accountId)));
  const foundation = async (): Promise<FoundationStatus> => {
    const checks = await Promise.allSettled([pool.query('SELECT 1'), deps.redis.ping()]);
    return {protocolVersion: PROTOCOL_VERSION, database: checks[0].status === 'fulfilled' ? 'healthy' : 'unavailable', redis: checks[1].status === 'fulfilled' ? 'healthy' : 'unavailable', vault: deps.vault.unlocked ? 'healthy' : 'locked', paired: true, schemaVersion: 2};
  };
  app.get('/v1/foundation', foundation);
  app.get('/ready', async (_request, reply) => {
    const status = await foundation();
    if (status.database !== 'healthy' || status.redis !== 'healthy' || status.vault !== 'healthy') reply.code(503);
    return status;
  });
  app.post('/v1/vault/unlock', async request => {
    const body = vaultUnlockSchema.parse(request.body);
    let key: Uint8Array;
    try { key = decode(body.rootKey, 32); }
    catch { throw new HttpError(400, 'INVALID_KEY_ENCODING'); }
    const candidate = new Vault();
    const scope = {tenantId: identity.tenantId, groupId: identity.tenantId, entityId: identity.installationId, purpose: 'credential' as const};
    try {
      candidate.unlock(key);
      await withTenant(pool, identity.tenantId, async db => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [identity.tenantId]);
        const result = await db.query<{encrypted_envelope: Ciphertext}>('SELECT encrypted_envelope FROM app.vault_verifiers WHERE tenant_id = $1', [identity.tenantId]);
        if (result.rows[0]) {
          let proof: Uint8Array;
          try { proof = candidate.open(result.rows[0].encrypted_envelope, scope); }
          catch { throw new HttpError(403, 'VAULT_KEY_REJECTED'); }
          try { if (Buffer.from(proof).toString() !== 'MSM vault verifier v1') throw new HttpError(403, 'VAULT_KEY_REJECTED'); }
          finally { wipe(proof); }
        } else {
          const envelope = candidate.seal(new TextEncoder().encode('MSM vault verifier v1'), scope);
          await db.query('INSERT INTO app.vault_verifiers(tenant_id,encrypted_envelope) VALUES ($1,$2)', [identity.tenantId, envelope]);
        }
        await db.query('INSERT INTO app.audit_log(tenant_id,id,actor_id,verb,request_id) VALUES ($1,$2,$3,$4,$5)', [identity.tenantId, randomUUID(), identity.installationId, 'vault.unlocked', request.id]);
      });
      deps.vault.unlock(key);
    } finally { candidate.lock(); wipe(key); }
    return {status: 'unlocked'};
  });
  app.post('/v1/vault/lock', async () => { deps.vault.lock(); return {status: 'locked'}; });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({error: {code: 'NOT_FOUND', message: 'Recurso indisponível.'}}));
  app.setErrorHandler((error, request, reply) => {
    const hintedStatus = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const frameworkStatus = typeof hintedStatus === 'number' && hintedStatus >= 400 && hintedStatus < 500 ? hintedStatus : 500;
    const status = error instanceof HttpError || error instanceof WorkspaceError ? error.status : error instanceof ZodError ? 400 : frameworkStatus;
    const code = error instanceof HttpError || error instanceof WorkspaceError ? error.code : status === 413 ? 'PAYLOAD_TOO_LARGE' : status < 500 ? 'INVALID_REQUEST' : 'DEPENDENCY_UNAVAILABLE';
    // Do not log arbitrary Error objects: drivers can embed credentials and payloads.
    if (status >= 500) request.log.error({requestId: request.id, code}, 'Request failed');
    reply.code(status).send({error: {code, message: 'Não foi possível concluir a solicitação.', requestId: request.id}});
  });
  app.addHook('onClose', async () => deps.vault.lock());
  return app;
}
