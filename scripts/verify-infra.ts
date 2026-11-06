import { LocalClient } from '../apps/desktop/src/main/client.js';
import { resolve } from 'node:path';
const client = new LocalClient(resolve(process.env.MSM_RUNTIME_DIR ?? '.runtime', 'client'));
try {
  await client.initialize();
  const peer = await client.connect();
  const status = await client.status();
  console.log(JSON.stringify({installationId: peer.installationId, tenantId: peer.tenantId, ...status}, null, 2));
  if (status.database !== 'healthy' || status.redis !== 'healthy' || !status.paired) process.exitCode = 1;
} finally {client.dispose();}
