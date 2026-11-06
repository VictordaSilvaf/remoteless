import { request, Agent } from 'node:https';
import { readFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { foundationSchema, peerSchema, type FoundationStatus, type Peer } from '@msm/contracts';
import {labCommandSchema,uuidSchema,type LabCommand,type LabStatus,type LabResult,type LabFrame} from '@msm/contracts';
import {workspaceCommandSchema,type WorkspaceCommand,type WorkspaceResult} from '@msm/contracts';
import {engineCommandSchema,type EngineCommand,type EngineResult} from '@msm/contracts';

const connectionSchema = z.object({installationId: z.uuid(), tenantId: z.uuid(), apiOrigin: z.url()}).strict();
export class LocalClient {
  #agent: Agent | undefined;
  #origin = '';
  #installationId = '';
  constructor(private readonly directory: string) {}
  async initialize(): Promise<void> {
    const config = connectionSchema.parse(JSON.parse(await readFile(`${this.directory}/connection.json`, 'utf8')));
    const origin = new URL(config.apiOrigin);
    if (origin.protocol !== 'https:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('INVALID_LOCAL_ENDPOINT');
    this.#origin = origin.origin;
    this.#installationId = config.installationId;
    this.#agent = new Agent({keepAlive: true, maxSockets: 4, ca: await readFile(`${this.directory}/ca.crt`), cert: await readFile(`${this.directory}/desktop.crt`), key: await readFile(`${this.directory}/desktop.key`), rejectUnauthorized: true});
  }
  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.#agent || !path.startsWith('/v1/')) throw new Error('CLIENT_NOT_INITIALIZED');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, this.#origin), {method, agent: this.#agent, headers: encoded ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded)} : {}}, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (path.startsWith('/v1/lab/frame/')||path==='/v1/workspace/command'||path.startsWith('/v1/engine/')?2_000_000:128*1024)) { response.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); return; }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('BACKEND_UNAVAILABLE')));
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {error?: {code?: string}};
            if ((response.statusCode ?? 500) >= 400) reject(new Error(value.error?.code ?? 'REQUEST_REJECTED'));
            else resolve(value);
          } catch { reject(new Error('INVALID_BACKEND_RESPONSE')); }
        });
      });
      req.setTimeout(path==='/v1/workspace/command'||path==='/v1/engine/command'?30000:5000, () => req.destroy(new Error('BACKEND_TIMEOUT')));
      req.on('error', () => reject(new Error('BACKEND_UNAVAILABLE')));
      req.end(encoded);
    });
  }
  async connect(): Promise<Peer> {
    try { return peerSchema.parse(await this.call('GET', '/v1/session')); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'INSTALLATION_NOT_PAIRED') throw error; }
    const bootstrapToken = (await readFile(`${this.directory}/bootstrap-token`, 'utf8')).trim();
    try { await this.call('POST', '/v1/pair', {installationId: this.#installationId, bootstrapToken}); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'INSTALLATION_ALREADY_PAIRED') throw error; }
    await unlink(`${this.directory}/bootstrap-token`).catch(() => {});
    return peerSchema.parse(await this.call('GET', '/v1/session'));
  }
  async status(): Promise<FoundationStatus> { return foundationSchema.parse(await this.call('GET', '/v1/foundation')); }
  async unlock(rootKey: string): Promise<void> { await this.call('POST', '/v1/vault/unlock', {rootKey}); }
  async lock(): Promise<void> { await this.call('POST', '/v1/vault/lock'); }
  async labStatus(){return await this.call('GET','/v1/lab/status') as LabStatus;}
  async labCommand(command:LabCommand){return await this.call('POST','/v1/lab/command',labCommandSchema.parse(command)) as LabResult;}
  async labFrame(id:string){return await this.call('GET',`/v1/lab/frame/${uuidSchema.parse(id)}`) as LabFrame|null;}
  async workspace(command:WorkspaceCommand){return await this.call('POST','/v1/workspace/command',workspaceCommandSchema.parse(command)) as WorkspaceResult;}
  async engine(command:EngineCommand){
    const parsed=engineCommandSchema.parse(command);
    if(parsed.kind==='get'){
      const query=new URLSearchParams({offset:String(parsed.offset),limit:String(parsed.limit),...(parsed.campaignId?{campaignId:parsed.campaignId}:{})});
      return await this.call('GET',`/v1/engine/status?${query}`) as EngineResult;
    }
    return await this.call('POST','/v1/engine/command',parsed) as EngineResult;
  }
  dispose(): void { this.#agent?.destroy(); }
}
