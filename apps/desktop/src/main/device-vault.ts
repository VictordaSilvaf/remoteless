import { safeStorage } from 'electron';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Vault, cryptoReady, randomKey, randomSalt, deriveKey, encode, decode, wipe, KDF } from '@msm/crypto';
import { ciphertextSchema } from '@msm/contracts';

const scope = {tenantId: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002', entityId: '00000000-0000-4000-8000-000000000003', purpose: 'credential' as const};
const recordSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('os'), ciphertext: z.string().max(16_384)}).strict(),
  z.object({kind: z.literal('passphrase'), salt: z.string().length(24), ops: z.literal(KDF.ops), memory: z.literal(KDF.memory), envelope: ciphertextSchema}).strict(),
]);
export async function deviceRoot(directory: string, passphrase?: string): Promise<Uint8Array> {
  await cryptoReady();
  await mkdir(directory, {recursive: true, mode: 0o700});
  const filename = join(directory, 'root-key.json');
  let saved: z.infer<typeof recordSchema> | undefined;
  try { saved = recordSchema.parse(JSON.parse(await readFile(filename, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('DEVICE_VAULT_INVALID'); }
  const secureOs = await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend()));
  if (saved?.kind === 'os') {
    if (!secureOs) throw new Error('OS_VAULT_UNAVAILABLE');
    const result = await safeStorage.decryptStringAsync(Buffer.from(saved.ciphertext, 'base64'));
    if (result.shouldReEncrypt) {
      const ciphertext = (await safeStorage.encryptStringAsync(result.result)).toString('base64');
      await writeFile(`${filename}.next`, JSON.stringify({kind: 'os', ciphertext}), {mode: 0o600});
      await rename(`${filename}.next`, filename);
    }
    return decode(result.result, 32);
  }
  if (saved?.kind === 'passphrase') {
    if (!passphrase) throw new Error('VAULT_PASSPHRASE_REQUIRED');
    const kek = deriveKey(passphrase, decode(saved.salt, 16));
    const vault = new Vault();
    try { vault.unlock(kek); return vault.open(saved.envelope, scope); }
    catch { throw new Error('VAULT_PASSPHRASE_INVALID'); }
    finally { vault.lock(); wipe(kek); }
  }
  const key = randomKey();
  try {
    if (secureOs) {
      await writeFile(filename, JSON.stringify({kind: 'os', ciphertext: (await safeStorage.encryptStringAsync(encode(key))).toString('base64')}), {mode: 0o600, flag: 'wx'});
    } else {
      if (!passphrase) throw new Error('VAULT_PASSPHRASE_REQUIRED');
      const salt = randomSalt();
      const kek = deriveKey(passphrase, salt);
      const vault = new Vault();
      try {
        vault.unlock(kek);
        await writeFile(filename, JSON.stringify({kind: 'passphrase', salt: encode(salt), ...KDF, envelope: vault.seal(key, scope)}), {mode: 0o600, flag: 'wx'});
      } finally { vault.lock(); wipe(kek); }
    }
    return new Uint8Array(key);
  } finally { wipe(key); }
}
