import {createHash, createPrivateKey, X509Certificate} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';

const identitySchema = z.object({installationId:z.uuid(), tenantId:z.uuid()});
export async function checkInstallation(directory: string) {
  const root = resolve(directory);
  async function restricted(path: string, directory = false) {
    const info = await lstat(`${root}/${path}`);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw Error(`INVALID_RUNTIME_FILE: ${path}`);
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw Error(`INSECURE_RUNTIME_PERMISSIONS: ${path}`);
  }
  for (const path of ['', 'client', 'server', 'authority', 'secrets']) await restricted(path, true);
  for (const path of ['authority/ca.key','client/desktop.key','server/server.key','server/health.key','client/connection.json','server/installation.json','secrets/postgres_password','secrets/app_password','secrets/redis_password']) await restricted(path);
  const connection = z.object({installationId:z.uuid(),tenantId:z.uuid(),apiOrigin:z.url()}).strict().parse(JSON.parse(await readFile(`${root}/client/connection.json`,'utf8')));
  const installation = z.object({installationId:z.uuid(),tenantId:z.uuid(),apiOrigin:z.url().optional(),clientFingerprint:z.string(),bootstrapHash:z.string().regex(/^[a-f0-9]{64}$/),bootstrapExpiresAt:z.iso.datetime()}).strict().parse(JSON.parse(await readFile(`${root}/server/installation.json`,'utf8')));
  if (JSON.stringify(identitySchema.parse(connection)) !== JSON.stringify(identitySchema.parse(installation))) throw Error('INSTALLATION_IDENTITY_MISMATCH');
  if (installation.apiOrigin && installation.apiOrigin !== connection.apiOrigin) throw Error('INSTALLATION_ORIGIN_MISMATCH');
  const origin = new URL(connection.apiOrigin);
  if (origin.protocol !== 'https:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('INVALID_LOCAL_ENDPOINT');
  const ca = new X509Certificate(await readFile(`${root}/authority/ca.crt`));
  if (!ca.ca || !ca.verify(ca.publicKey) || !ca.checkPrivateKey(createPrivateKey(await readFile(`${root}/authority/ca.key`)))) throw Error('INVALID_LOCAL_CA');
  const certificates = [];
  for (const [path,purpose] of [['authority/ca','ca'],['client/desktop','client'],['server/server','server'],['server/health','client']] as const) {
    const certificate = new X509Certificate(await readFile(`${root}/${path}.crt`));
    if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw Error(`CERTIFICATE_EXPIRED_OR_NOT_VALID: ${path}`);
    if (!certificate.verify(ca.publicKey) || !certificate.checkPrivateKey(createPrivateKey(await readFile(`${root}/${path}.key`)))) throw Error(`CERTIFICATE_KEY_MISMATCH: ${path}`);
    if (purpose !== 'ca' && !certificate.keyUsage?.includes(purpose === 'server' ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.2')) throw Error(`CERTIFICATE_PURPOSE_MISMATCH: ${path}`);
    if (purpose === 'server' && !certificate.checkIP('127.0.0.1')) throw Error('SERVER_CERTIFICATE_HOST_MISMATCH');
    if (path === 'client/desktop' && certificate.fingerprint256 !== installation.clientFingerprint) throw Error('CLIENT_CERTIFICATE_PIN_MISMATCH');
    certificates.push({path,expiresAt:certificate.validTo});
  }
  for (const path of ['client/ca.crt','server/ca.crt']) if (!(await readFile(`${root}/${path}`)).equals(await readFile(`${root}/authority/ca.crt`))) throw Error('CA_COPY_MISMATCH');
  for (const name of ['postgres_password','app_password','redis_password']) if (!/^[A-Za-z0-9+/]{43}=$/.test((await readFile(`${root}/secrets/${name}`,'utf8')).trim())) throw Error(`INVALID_SERVICE_SECRET: ${name}`);
  let pairing: 'pending'|'expired'|'consumed' = 'consumed';
  try {
    await restricted('client/bootstrap-token');
    const token = (await readFile(`${root}/client/bootstrap-token`,'utf8')).trim();
    if (createHash('sha256').update(token).digest('hex') !== installation.bootstrapHash) throw Error('PAIRING_TOKEN_MISMATCH');
    pairing = Date.parse(installation.bootstrapExpiresAt) > Date.now() ? 'pending' : 'expired';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {passed:true,platform:process.platform,arch:process.arch,identity:'consistent',privateFiles:'restricted',certificates,pairing};
}

