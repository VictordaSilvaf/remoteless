import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopBridge } from '@msm/contracts';

const bridge: DesktopBridge = Object.freeze({
  security:Object.freeze({sandboxed:process.sandboxed??false,contextIsolated:process.contextIsolated??false}),
  workspace:Object.freeze({run:(command:Parameters<DesktopBridge['workspace']['run']>[0])=>ipcRenderer.invoke(IPC.workspace,command)}),
  lab:Object.freeze({status:()=>ipcRenderer.invoke(IPC.labStatus),command:(command:Parameters<DesktopBridge['lab']['command']>[0])=>ipcRenderer.invoke(IPC.labCommand,command),frame:(id:string)=>ipcRenderer.invoke(IPC.labFrame,id)}),
  connect: () => ipcRenderer.invoke(IPC.connect),
  status: () => ipcRenderer.invoke(IPC.status),
  unlockVault: (input: Parameters<DesktopBridge['unlockVault']>[0]) => ipcRenderer.invoke(IPC.unlock, input),
  lockVault: () => ipcRenderer.invoke(IPC.lock),
});
contextBridge.exposeInMainWorld('multisession', bridge);
