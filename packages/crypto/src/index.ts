import sodium from 'libsodium-wrappers-sumo';
import { ciphertextSchema, vaultScopeSchema, type Ciphertext, type VaultScope } from '@msm/contracts';

export async function cryptoReady(): Promise<void> { await sodium.ready; }
export function randomKey(): Uint8Array { return sodium.randombytes_buf(32); }
export function encode(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }
export function decode(value: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('INVALID_ENCODING');
  const bytes = Buffer.from(value, 'base64');
  if (encode(bytes) !== value || (length !== undefined && bytes.length !== length)) throw new Error('INVALID_ENCODING');
  return bytes;
}
function aad(scope: VaultScope, kind: 'data' | 'key'): Uint8Array {
  const s = vaultScopeSchema.parse(scope);
  return new TextEncoder().encode(JSON.stringify([1, kind, s.tenantId, s.groupId, s.entityId, s.purpose]));
}
export class Vault {
  #root: Uint8Array | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly idleMs = 15 * 60_000) {}
  get unlocked(): boolean { return this.#root !== undefined; }
  unlock(key: Uint8Array): void {
    if (key.length !== 32) throw new Error('INVALID_KEY');
    this.lock();
    this.#root = new Uint8Array(key);
    this.#touch();
  }
  lock(): void {
    if (this.#root) sodium.memzero(this.#root);
    this.#root = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  #key(): Uint8Array {
    if (!this.#root) throw new Error('VAULT_LOCKED');
    this.#touch();
    return this.#root;
  }
  #touch(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.lock(), this.idleMs);
    this.#timer.unref();
  }
  seal(plaintext: Uint8Array, scope: VaultScope): Ciphertext {
    const root = this.#key();
    const dek = randomKey();
    const nonce = sodium.randombytes_buf(24);
    const wrappedKeyNonce = sodium.randombytes_buf(24);
    try {
      return {
        version: 1, algorithm: 'xchacha20-poly1305', keyId: 'root-v1',
        nonce: encode(nonce), wrappedKeyNonce: encode(wrappedKeyNonce),
        wrappedKey: encode(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(dek, aad(scope, 'key'), null, wrappedKeyNonce, root)),
        ciphertext: encode(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad(scope, 'data'), null, nonce, dek)),
      };
    } finally { sodium.memzero(dek); }
  }
  open(input: Ciphertext, scope: VaultScope): Uint8Array {
    const envelope = ciphertextSchema.parse(input);
    const root = this.#key();
    let dek: Uint8Array | undefined;
    try {
      dek = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, decode(envelope.wrappedKey), aad(scope, 'key'), decode(envelope.wrappedKeyNonce, 24), root);
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, decode(envelope.ciphertext), aad(scope, 'data'), decode(envelope.nonce, 24), dek);
    } catch { throw new Error('INTEGRITY_CHECK_FAILED'); }
    finally { if (dek) sodium.memzero(dek); }
  }
  lookup(value:string,tenantId:string):string {
    const scope=vaultScopeSchema.parse({tenantId,groupId:tenantId,entityId:tenantId,purpose:'credential'});
    const key=sodium.crypto_generichash(32,new TextEncoder().encode(`lookup-v1:${scope.tenantId}`),this.#key());
    try{return encode(sodium.crypto_auth_hmacsha256(new TextEncoder().encode(value),key));}
    finally{wipe(key);}
  }
}
export const KDF = { ops: 2, memory: 64 * 1024 * 1024 } as const;
export function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  if (passphrase.length < 12 || passphrase.length > 256 || salt.length !== 16) throw new Error('INVALID_PASSPHRASE');
  return sodium.crypto_pwhash(32, passphrase, salt, KDF.ops, KDF.memory, sodium.crypto_pwhash_ALG_ARGON2ID13);
}
export function randomSalt(): Uint8Array { return sodium.randombytes_buf(16); }
export function wipe(value: Uint8Array): void { sodium.memzero(value); }
