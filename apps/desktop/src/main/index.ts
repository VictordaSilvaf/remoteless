import { app, BrowserWindow, ipcMain, protocol, net, session } from 'electron';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {mkdirSync} from 'node:fs';
import { IPC, desktopUnlockSchema,labCommandSchema,uuidSchema,workspaceCommandSchema,engineCommandSchema } from '@msm/contracts';
import { encode, wipe } from '@msm/crypto';
import { LocalClient } from './client.js';
import { deviceRoot } from './device-vault.js';
import { trustedFrameUrl } from './ipc-policy.js';

app.setName('MultiSession Manager');
if(process.env.MSM_DESKTOP_DATA_DIR){const directory=resolve(process.env.MSM_DESKTOP_DATA_DIR);mkdirSync(directory,{recursive:true,mode:0o700});app.setPath('userData',directory);}
protocol.registerSchemesAsPrivileged([{scheme: 'msm', privileges: {standard: true, secure: true, supportFetchAPI: true}}]);
const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(process.env.MSM_RUNTIME_DIR ?? '.runtime');
const client = new LocalClient(resolve(runtime, 'client'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  void app.whenReady().then(async()=>{
  const rendererRoot = resolve(here, 'renderer');
  protocol.handle('msm', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Forbidden', {status: 403});
    let path: string;
    try { path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`); }
    catch { return new Response('Bad request', {status: 400}); }
    if (!path.startsWith(`${rendererRoot}${sep}`)) return new Response('Forbidden', {status: 403});
    return net.fetch(pathToFileURL(path).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({width: 1160, height: 780, minWidth: 800, minHeight: 600, backgroundColor: '#0b101b', title: 'MultiSession Manager', webPreferences: {preload: resolve(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const authorize = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedFrameUrl(event.senderFrame.url)) throw new Error('IPC_FORBIDDEN');
  };
  let initialized = false;
  let unlocking = false;
  ipcMain.handle(IPC.connect, async event => { authorize(event); if (!initialized) { await client.initialize(); initialized = true; } return client.connect(); });
  ipcMain.handle(IPC.status, event => { authorize(event); return client.status(); });
  ipcMain.handle(IPC.unlock, async (event, input: unknown) => {
    authorize(event);
    const body = desktopUnlockSchema.parse(input);
    if (unlocking) throw new Error('VAULT_BUSY');
    unlocking = true;
    try {
      const key = await deviceRoot(resolve(app.getPath('userData'), 'vault'), body.passphrase);
      try { await client.unlock(encode(key)); } finally { wipe(key); }
    } finally { unlocking = false; }
  });
  ipcMain.handle(IPC.lock, event => { authorize(event); return client.lock(); });
  ipcMain.handle(IPC.labStatus,event=>{authorize(event);return client.labStatus();});
  ipcMain.handle(IPC.labCommand,(event,input:unknown)=>{authorize(event);return client.labCommand(labCommandSchema.parse(input));});
  ipcMain.handle(IPC.labFrame,(event,input:unknown)=>{authorize(event);return client.labFrame(uuidSchema.parse(input));});
  ipcMain.handle(IPC.workspace,(event,input:unknown)=>{authorize(event);return client.workspace(workspaceCommandSchema.parse(input));});
  ipcMain.handle(IPC.engine,(event,input:unknown)=>{authorize(event);return client.engine(engineCommandSchema.parse(input));});
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.focus(); });
  app.on('before-quit', () => { client.dispose(); });
  await window.loadURL('msm://app/');
  app.on('window-all-closed', () => app.quit());
  }).catch(error=>{console.error('DESKTOP_START_FAILED',error instanceof Error?error.message:'UNKNOWN');app.quit();});
}
