import {z} from 'zod';

const id=z.uuid(),name=z.string().trim().min(1).max(120);
const revision={id:id.optional(),version:z.number().int().positive().optional()};
const policy=z.object({windowSeconds:z.number().int().min(0).max(86400),maxActionsHour:z.number().int().min(1).max(10000),maxConcurrency:z.number().int().min(1).max(6)}).strict();
export const defaultGroupPolicy={windowSeconds:3600,maxActionsHour:60,maxConcurrency:2};
export type GroupPolicy=z.infer<typeof policy>;
export const accountStates=['UNKNOWN','ACTIVE','BLOCKED','BANNED','MAINTENANCE','LOGIN_ERROR'] as const;
const command=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('get'),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50),search:z.string().trim().max(120).default(''),groupId:id.optional(),siteId:id.optional()}).strict(),
  z.object({kind:z.literal('group.save'),...revision,name,enabled:z.boolean().default(true),policy:policy.default(defaultGroupPolicy)}).strict(),
  z.object({kind:z.literal('group.delete'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('site.save'),...revision,name,url:z.string().max(2048),origins:z.array(z.string().max(2048)).min(1).max(20).optional()}).strict(),
  z.object({kind:z.literal('site.delete'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('account.save'),...revision,alias:name,groupId:id,siteId:id,login:z.string().trim().min(1).max(256).nullable().optional(),password:z.string().min(1).max(1024).nullable().optional(),notes:z.string().max(2000).default(''),enabled:z.boolean().default(true),state:z.enum(accountStates).default('UNKNOWN'),proxyId:id.nullable().optional()}).strict(),
  z.object({kind:z.literal('account.delete'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('account.enabled'),id,version:z.number().int().positive(),enabled:z.boolean()}).strict(),
  z.object({kind:z.literal('proxy.save'),...revision,groupId:id,scheme:z.enum(['http','https','socks5']),host:z.string().trim().min(1).max(253),port:z.number().int().min(1).max(65535),username:z.string().max(255).nullable().optional(),password:z.string().max(255).nullable().optional(),maxAccounts:z.number().int().min(1).max(500),enabled:z.boolean().default(true)}).strict(),
  z.object({kind:z.literal('proxy.delete'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('proxy.test'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('proxy.distribute'),groupId:id,accountIds:z.array(id).min(1).max(500)}).strict(),
  z.object({kind:z.literal('proxy.rotate'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('import.preview'),entity:z.enum(['accounts','proxies']),groupId:id,siteId:id.optional(),raw:z.string().min(1).max(512000)}).strict(),
  z.object({kind:z.literal('import.get'),id}).strict(),
  z.object({kind:z.literal('import.commit'),id,hash:z.string().regex(/^[a-f0-9]{64}$/),acceptPartial:z.boolean().default(false)}).strict(),
]);
export const workspaceCommandSchema=command.superRefine((value,context)=>{
  if((value.kind==='group.save'||value.kind==='site.save'||value.kind==='account.save'||value.kind==='proxy.save')&&Boolean(value.id)!==Boolean(value.version))context.addIssue({code:'custom',message:'An update requires id and version.'});
  if(value.kind==='import.preview'&&value.entity==='accounts'&&!value.siteId)context.addIssue({code:'custom',message:'Account imports require a site.'});
});
export type WorkspaceCommand=z.input<typeof workspaceCommandSchema>;
export type ParsedWorkspaceCommand=z.output<typeof workspaceCommandSchema>;
export interface GroupRecord {id:string;name:string;enabled:boolean;version:number;policy:GroupPolicy;accounts:number;}
export interface SiteRecord {id:string;name:string;url:string;origins:string[];version:number;capability:'generic';}
export interface ProxyRecord {id:string;groupId:string;scheme:'http'|'https'|'socks5';host:string;port:number;maxAccounts:number;assigned:number;enabled:boolean;hasAuth:boolean;state:'UNKNOWN'|'HEALTHY'|'UNAVAILABLE';egressIp:string|null;latencyMs:number|null;checkedAt:string|null;errorCode:string|null;version:number;}
export interface AccountRecord {id:string;alias:string;groupId:string;siteId:string;proxyId:string|null;enabled:boolean;state:typeof accountStates[number];authState:'UNKNOWN';runtimeState:string;notes:string;hasLogin:boolean;hasPassword:boolean;version:number;}
export interface ImportRow {row:number;alias:string;valid:boolean;errors:string[];}
export interface ImportPreview {id:string;hash:string;entity:'accounts'|'proxies';rows:ImportRow[];validCount:number;errorCount:number;expiresAt:string;state:'PREVIEW'|'COMMITTED';committedIds:string[];}
export interface WorkspaceSnapshot {groups:GroupRecord[];sites:SiteRecord[];proxies:ProxyRecord[];accounts:AccountRecord[];total:number;offset:number;limit:number;quota:{used:number;max:number};vaultUnlocked:boolean;audit:{id:string;verb:string;targetId:string|null;createdAt:string}[];}
export interface WorkspaceResult {snapshot?:WorkspaceSnapshot;entity?:{id:string;version:number};preview?:ImportPreview;check?:{state:'HEALTHY'|'UNAVAILABLE';egressIp:string|null;latencyMs:number;errorCode:string|null};assigned?:number;}
export interface WorkspacePort {run(command:WorkspaceCommand):Promise<WorkspaceResult>;}
