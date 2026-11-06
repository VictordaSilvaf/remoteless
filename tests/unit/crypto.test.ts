import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Vault, cryptoReady, randomKey, randomSalt, deriveKey, encode, decode, wipe} from '@msm/crypto';
import type {VaultScope} from '@msm/contracts';

before(cryptoReady);
const scope: VaultScope = {tenantId: randomUUID(), groupId: randomUUID(), entityId: randomUUID(), purpose: 'credential'};
test('envelope encryption binds tenant, group, entity and purpose', () => {
  const root = randomKey();
  const vault = new Vault();
  vault.unlock(root);
  const secret = new TextEncoder().encode('canary-password-never-in-envelope');
  const envelope = vault.seal(secret, scope);
  assert.deepEqual(vault.open(envelope, scope), secret);
  assert.ok(!JSON.stringify(envelope).includes('canary-password'));
  for (const modified of [{...scope, tenantId: randomUUID()}, {...scope, groupId: randomUUID()}, {...scope, entityId: randomUUID()}, {...scope, purpose: 'session' as const}]) {
    assert.throws(() => vault.open(envelope, modified), /INTEGRITY_CHECK_FAILED/);
  }
  const other = vault.seal(secret, scope);
  assert.notEqual(envelope.nonce, other.nonce);
  assert.notEqual(envelope.wrappedKey, other.wrappedKey);
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  ciphertext[0] = ciphertext[0]! ^ 1;
  assert.throws(() => vault.open({...envelope, ciphertext: ciphertext.toString('base64')}, scope), /INTEGRITY_CHECK_FAILED/);
  vault.lock(); wipe(root);
  assert.throws(() => vault.open(envelope, scope), /VAULT_LOCKED/);
});
test('wrong root key cannot decrypt and noncanonical encoding is rejected', () => {
  const vault = new Vault();
  vault.unlock(randomKey());
  const envelope = vault.seal(new Uint8Array([1,2,3]), scope);
  vault.unlock(randomKey());
  assert.throws(() => vault.open(envelope, scope), /INTEGRITY_CHECK_FAILED/);
  assert.throws(() => decode('not base64!'), /INVALID_ENCODING/);
  assert.throws(() => decode('AA==', 32), /INVALID_ENCODING/);
  vault.lock();
});
test('vault automatically locks after inactivity', async () => {
  const vault = new Vault(20);
  vault.unlock(randomKey());
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(vault.unlocked, false);
});
test('Argon2id is deterministic for the same salt and separates salts', () => {
  const salt = randomSalt();
  const first = deriveKey('strong-local-vault-passphrase', salt);
  const repeated = deriveKey('strong-local-vault-passphrase', salt);
  const other = deriveKey('strong-local-vault-passphrase', randomSalt());
  assert.equal(encode(first), encode(repeated));
  assert.notEqual(encode(first), encode(other));
  assert.throws(() => deriveKey('short', salt), /INVALID_PASSPHRASE/);
  [first, repeated, other].forEach(wipe);
});
