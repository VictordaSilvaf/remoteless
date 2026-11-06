import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const child = spawn(process.execPath, [resolve('node_modules/electron/install.js')], {stdio:'inherit', env:{...process.env, electron_config_cache:resolve('.runtime/electron-cache')}});
child.once('error', () => {process.exitCode=1;});
child.once('exit', code => {process.exitCode=code ?? 1;});
