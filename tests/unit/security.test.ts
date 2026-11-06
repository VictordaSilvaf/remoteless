import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trustedFrameUrl} from '../../apps/desktop/src/main/ipc-policy.js';
import {pairRequestSchema, desktopUnlockSchema} from '@msm/contracts';
import {randomUUID} from 'node:crypto';

test('IPC accepts only the packaged application origin', () => {
  assert.equal(trustedFrameUrl('msm://app/'), true);
  for (const url of ['https://app/', 'file:///etc/passwd', 'msm://app.evil/', 'msm://evil/', 'msm://user@app/', 'msm://app:5000/', 'invalid']) assert.equal(trustedFrameUrl(url), false, url);
});
test('pairing contract rejects client-selected tenant and unknown fields', () => {
  const body = {installationId: randomUUID(), bootstrapToken: 'x'.repeat(43)};
  assert.ok(pairRequestSchema.safeParse(body).success);
  assert.equal(pairRequestSchema.safeParse({...body, tenantId: randomUUID()}).success, false);
  assert.equal(pairRequestSchema.safeParse({...body, bootstrapToken: ''}).success, false);
  assert.equal(desktopUnlockSchema.safeParse({passphrase: 'short'}).success, false);
});
