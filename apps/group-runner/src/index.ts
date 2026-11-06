import { createServer, createConnection } from 'node:net';
import { chromium } from 'playwright';
import { uuidSchema } from '@msm/contracts';

const groupId = uuidSchema.parse(process.env.MSM_GROUP_ID);
if (process.getuid?.() === 0) throw new Error('ROOT_RUNNER_FORBIDDEN');
async function directConnectionPossible(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({host: '1.1.1.1', port: 443});
    socket.setTimeout(1500);
    socket.once('connect', () => {socket.destroy(); resolve(true);});
    socket.once('timeout', () => {socket.destroy(); resolve(false);});
    socket.once('error', () => {socket.destroy(); resolve(false);});
  });
}
if (await directConnectionPossible()) throw new Error('DIRECT_EGRESS_NOT_BLOCKED');
const bridge = createServer(client => {
  const upstream = createConnection('/proxy/egress.sock');
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.pipe(upstream).pipe(client);
  client.on('close', () => upstream.destroy());
});
await new Promise<void>(resolve => bridge.listen(3138, '127.0.0.1', resolve));
const browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, proxy: {server: 'http://127.0.0.1:3138'}});
try {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const page = await first.newPage();
  await page.goto('http://fixture.test/', {timeout: 10_000});
  if (await page.locator('#result').innerText() !== 'proxy-only') throw new Error('PROXY_PROBE_FAILED');
  await first.addCookies([{name: 'isolation', value: 'account-a', url: 'http://fixture.test'}]);
  if ((await second.cookies()).some(cookie => cookie.name === 'isolation')) throw new Error('CONTEXT_ISOLATION_FAILED');
  const snapshot = await first.storageState();
  await first.close();
  const restored = await browser.newContext({storageState: snapshot});
  if (!(await restored.cookies()).some(cookie => cookie.value === 'account-a')) throw new Error('RESTORE_PROBE_FAILED');
  const sandbox = await second.newPage();
  await sandbox.goto('chrome://sandbox/');
  const diagnostics = await sandbox.locator('body').innerText();
  if (!/Seccomp-BPF sandbox\s+Yes/i.test(diagnostics) || !/(?:Namespace sandbox|PID namespaces)\s+Yes/i.test(diagnostics)) throw new Error('SANDBOX_NOT_CONFIRMED');
  await restored.close();
  await second.close();
  console.log(JSON.stringify({groupId, directEgress: 'blocked', proxy: 'verified', contexts: 'isolated', restore: 'verified', sandbox: 'verified'}));
} finally {await browser.close(); await new Promise<void>(resolve => bridge.close(() => resolve()));}
