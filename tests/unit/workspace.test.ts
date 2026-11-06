import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {workspaceCommandSchema} from '@msm/contracts';
import {parseCsv,importRecords} from '../../apps/local-api/src/workspace/csv.js';
import {publicAddress,siteUrl,resolvePublic,canonicalHost} from '../../apps/local-api/src/workspace/network.js';
import {Vault,cryptoReady,randomKey} from '@msm/crypto';

test('CSV preserves quoted delimiters, Unicode, escaped quotes and multiline fields within 500 rows',()=>{
  assert.deepEqual(parseCsv('\uFEFFalias;login;password;notes\r\n"Conta, ação";user;"pa""ss";"linha 1\nlinha 2"\r\n'),[['alias','login','password','notes'],['Conta, ação','user','pa"ss','linha 1\nlinha 2']]);
  const input='alias;login;password\n'+Array.from({length:500},(_,i)=>`Conta ${i};user${i};password`).join('\n');
  assert.equal(importRecords(input,'accounts').length,500);
  assert.throws(()=>parseCsv(input+'\nExtra;extra;password'),/IMPORT_ROW_LIMIT/);
  assert.throws(()=>parseCsv('alias,login\n"unterminated,user'),/CSV_MALFORMED/);
  assert.equal(importRecords('user:pass:with:colon','accounts')[0]!.values.password,'pass:with:colon');
  assert.equal(importRecords('socks5://user:pass@8.8.8.8:1080','proxies')[0]!.values.scheme,'socks5');
  assert.equal(importRecords('http://8.8.8.8:8080/unexpected','proxies')[0]!.error,'INVALID_PROXY_URL');
});
test('workspace commands require update revisions and refuse cross-tenant and executable fields',()=>{
  assert.equal(workspaceCommandSchema.safeParse({kind:'group.save',id:randomUUID(),name:'Missing revision'}).success,false);
  assert.equal(workspaceCommandSchema.safeParse({kind:'group.save',version:2,name:'Missing id'}).success,false);
  assert.equal(workspaceCommandSchema.safeParse({kind:'get',tenantId:randomUUID()}).success,false);
  assert.equal(workspaceCommandSchema.safeParse({kind:'get',script:'process.exit()'}).success,false);
  assert.equal(workspaceCommandSchema.safeParse({kind:'import.preview',entity:'accounts',groupId:randomUUID(),raw:'login,password\na,b'}).success,false);
});
test('site policy rejects private, reserved, encoded loopback and mixed DNS answers',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','172.17.0.1','192.168.1.1','::1','::ffff:127.0.0.1','fe80::1','fd00::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  assert.equal(canonicalHost('2606:4700:4700:0:0:0:0:1111'),'2606:4700:4700::1111');
  for(const url of ['http://2130706433/','http://0x7f000001/','http://[::1]/','file:///tmp/a','http://user:password@8.8.8.8/'])await assert.rejects(()=>siteUrl(url));
  await assert.rejects(()=>resolvePublic('public.example',{resolve:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]}),/DESTINATION_FORBIDDEN/);
  assert.equal((await siteUrl('https://EXAMPLE.COM:443/a',{resolve:async()=>[{address:'8.8.8.8',family:4}]})).href,'https://example.com/a');
});
test('login lookups are keyed, tenant-specific and unavailable when the vault is locked',async()=>{
  await cryptoReady();const vault=new Vault();vault.unlock(randomKey());const a=randomUUID(),b=randomUUID();
  assert.equal(vault.lookup('same-user',a),vault.lookup('same-user',a));assert.notEqual(vault.lookup('same-user',a),vault.lookup('same-user',b));
  const other=new Vault();other.unlock(randomKey());assert.notEqual(vault.lookup('same-user',a),other.lookup('same-user',a));other.lock();
  vault.lock();assert.throws(()=>vault.lookup('same-user',a),/VAULT_LOCKED/);
});
