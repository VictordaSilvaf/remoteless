import { randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.env.MSM_RUNTIME_DIR ?? '.runtime');
const client = join(root, 'client');
const server = join(root, 'server');
const authority = join(root, 'authority');
const secrets = join(root, 'secrets');
const lab = join(root, 'lab');
await mkdir(root, {recursive: true, mode: 0o700});
await chmod(root, 0o700);
for (const dir of [client, server, authority, secrets,lab,join(root,'artifacts')]) await mkdir(dir, {recursive: true, mode: 0o700});
await mkdir(join(root,'artifacts','phase0-electron'),{recursive:true,mode:0o700});
const exists = async (path: string) => access(path).then(() => true, () => false);
const save = async (path: string, value: string) => writeFile(path, value, {mode: 0o600, flag: 'wx'});
function openssl(args: string[]): void { execFileSync('openssl', args, {stdio: ['ignore', 'ignore', 'pipe']}); }
if (!await exists(join(authority, 'ca.key'))) {
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '365', '-subj', '/CN=MSM Local Installation CA', '-keyout', join(authority, 'ca.key'), '-out', join(authority, 'ca.crt')]);
  await chmod(join(authority, 'ca.key'), 0o600);
}
async function certificate(dir: string, name: string, purpose: 'serverAuth' | 'clientAuth', cn: string): Promise<void> {
  if (await exists(join(dir, `${name}.crt`))) return;
  const ext = join(authority, `${name}.ext`);
  await writeFile(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${purpose}\n${purpose === 'serverAuth' ? 'subjectAltName=DNS:localhost,DNS:api,IP:127.0.0.1\n' : ''}`, {mode: 0o600});
  openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=${cn}`, '-keyout', join(dir, `${name}.key`), '-out', join(authority, `${name}.csr`)]);
  openssl(['x509', '-req', '-in', join(authority, `${name}.csr`), '-CA', join(authority, 'ca.crt'), '-CAkey', join(authority, 'ca.key'), '-CAcreateserial', '-days', '90', '-extfile', ext, '-out', join(dir, `${name}.crt`)]);
  await chmod(join(dir, `${name}.key`), 0o600);
}
const configPath = join(client, 'connection.json');
if (!await exists(configPath)) {
  const installationId = randomUUID();
  const tenantId = randomUUID();
  await save(configPath, JSON.stringify({installationId, tenantId, apiOrigin: 'https://127.0.0.1:17643'}, null, 2));
}
const identity = JSON.parse(await readFile(configPath, 'utf8')) as {installationId: string; tenantId: string};
if(!await exists(join(lab,'config.json'))){
  const configuration={tenantId:identity.tenantId,groupId:randomUUID(),capability:randomBytes(32).toString('base64url')};
  await save(join(lab,'config.json'),JSON.stringify(configuration));
  await save(join(server,'lab.json'),JSON.stringify(configuration));
  await save(join(lab,'root-key'),randomBytes(32).toString('base64'));
}
await certificate(client, 'desktop', 'clientAuth', identity.installationId);
await certificate(server, 'server', 'serverAuth', 'MSM Local API');
await certificate(server, 'health', 'clientAuth', 'MSM Health Probe');
for (const dir of [client, server]) await writeFile(join(dir, 'ca.crt'), await readFile(join(authority, 'ca.crt')), {mode: 0o600});
for (const name of ['postgres_password', 'app_password', 'redis_password']) {
  if (!await exists(join(secrets, name))) await save(join(secrets, name), randomBytes(32).toString('base64'));
}
if (!await exists(join(server, 'installation.json')) || process.argv.includes('--renew-pairing-token')) {
  const bootstrapToken = randomBytes(32).toString('base64url');
  await writeFile(join(client, 'bootstrap-token'), bootstrapToken, {mode: 0o600});
  const cert = new X509Certificate(await readFile(join(client, 'desktop.crt')));
  await writeFile(join(server, 'installation.json'), JSON.stringify({
    ...identity,
    clientFingerprint: cert.fingerprint256,
    bootstrapHash: createHash('sha256').update(bootstrapToken).digest('hex'),
    bootstrapExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  }, null, 2), {mode: 0o600});
}
console.log('Configuração local pronta em .runtime/ (segredos não exibidos).');
console.log('Certificados locais válidos por 90 dias. Pareamento inicial: token válido por 30 minutos.');
console.log('Próximo passo: npm run infra:up');
