import { z } from 'zod';
import type {LabPort} from './lab.js';
import type {WorkspacePort} from './workspace.js';
import type {EnginePort} from './engine.js';
export * from './lab.js';
export * from './workspace.js';
export * from './engine.js';

export const PROTOCOL_VERSION = 1;
export const uuidSchema = z.uuid();
export const pairRequestSchema = z.object({
  installationId: uuidSchema,
  bootstrapToken: z.string().min(40).max(128),
}).strict();
export const peerSchema = z.object({
  installationId: uuidSchema,
  tenantId: uuidSchema,
  protocolVersion: z.literal(PROTOCOL_VERSION),
}).strict();
export const dependencySchema = z.enum(['healthy', 'unavailable', 'locked']);
export const foundationSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  database: dependencySchema,
  redis: dependencySchema,
  vault: dependencySchema,
  paired: z.boolean(),
  schemaVersion: z.number().int().nonnegative(),
}).strict();
export type FoundationStatus = z.infer<typeof foundationSchema>;
export type Peer = z.infer<typeof peerSchema>;
export const vaultUnlockSchema = z.object({ rootKey: z.string().length(44) }).strict();
export const vaultScopeSchema = z.object({
  tenantId: uuidSchema,
  groupId: uuidSchema,
  entityId: uuidSchema,
  purpose: z.enum(['credential', 'session', 'proxy']),
}).strict();
export type VaultScope = z.infer<typeof vaultScopeSchema>;
export const ciphertextSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('xchacha20-poly1305'),
  keyId: z.literal('root-v1'),
  nonce: z.string().max(64),
  wrappedKeyNonce: z.string().max(64),
  wrappedKey: z.string().max(128),
  ciphertext: z.string().max(2_000_000),
}).strict();
export type Ciphertext = z.infer<typeof ciphertextSchema>;
export const desktopUnlockSchema = z.object({
  passphrase: z.string().min(12).max(256).optional(),
}).strict();
export interface DesktopBridge {
  readonly security:{sandboxed:boolean;contextIsolated:boolean};
  lab: LabPort;
  workspace: WorkspacePort;
  engine: EnginePort;
  connect(): Promise<Peer>;
  status(): Promise<FoundationStatus>;
  unlockVault(input: z.infer<typeof desktopUnlockSchema>): Promise<void>;
  lockVault(): Promise<void>;
}
export const IPC = Object.freeze({
  connect: 'msm:connect', status: 'msm:status',
  unlock: 'msm:vault-unlock', lock: 'msm:vault-lock',
  labStatus:'msm:lab-status',labCommand:'msm:lab-command',labFrame:'msm:lab-frame',
  workspace:'msm:workspace',
  engine:'msm:engine',
});
