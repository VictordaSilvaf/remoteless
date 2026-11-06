import {readFileSync} from 'node:fs';
import {get} from 'node:https';
const dir = process.env.MSM_SERVER_DIR;
const req = get('https://127.0.0.1:8443/status', {ca: readFileSync(`${dir}/ca.crt`), cert: readFileSync(`${dir}/health.crt`), key: readFileSync(`${dir}/health.key`), rejectUnauthorized: true}, res => {
  res.resume();
  res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
});
req.setTimeout(3000, () => req.destroy());
req.on('error', () => process.exit(1));
