import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixtureUrl} from '../../apps/session-lab/src/engine.js';
import {labCommandSchema} from '@msm/contracts';
import {randomUUID} from 'node:crypto';
test('phase0 only admits its fixture origins, including normalized URL variants',()=>{
  assert.equal(fixtureUrl('http://FIXTURE.test/demo'),'http://fixture.test/demo');
  for(const raw of ['http://127.0.0.1/','http://[::1]/','http://169.254.169.254/','http://fixture.test.evil/','http://user:password@fixture.test/','http://fixture.test:1234/','file:///etc/passwd','javascript:alert(1)','https://example.org/'])assert.throws(()=>fixtureUrl(raw),/LAB_FIXTURE_ONLY/);
});
test('phase0 DSL rejects arbitrary JavaScript, unknown fields and oversized rooms',()=>{
  assert.equal(labCommandSchema.safeParse({kind:'evaluate',script:'process.exit()'}).success,false);
  assert.equal(labCommandSchema.safeParse({kind:'open',accountId:randomUUID(),tenantId:randomUUID()}).success,false);
  assert.equal(labCommandSchema.safeParse({kind:'room',accountIds:Array.from({length:5},()=>randomUUID()),leaderId:randomUUID(),mirror:true}).success,false);
});
