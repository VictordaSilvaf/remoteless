import {z} from 'zod';

const id=z.uuid();
export const engineReadSchema=z.object({campaignId:id.optional(),offset:z.coerce.number().int().min(0).max(10000).default(0),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
export const engineStepSchema=z.object({kind:z.enum(['account.inspect','proxy.probe'])}).strict();
export type EngineStep=z.infer<typeof engineStepSchema>;
export const actionStates=['WAITING_PREDECESSOR','SCHEDULED','READY','LEASED','RUNNING','VERIFYING','SUCCEEDED','RETRY_WAIT','RECONCILING','UNKNOWN','FAILED','CANCELLED','EXPIRED','ABANDONED'] as const;
export type ActionState=typeof actionStates[number];
export const engineCommandSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('get'),campaignId:id.optional(),offset:z.number().int().min(0).max(10000).default(0),limit:z.number().int().min(1).max(100).default(50)}).strict(),
  z.object({kind:z.literal('recipe.save'),id:id.optional(),version:z.number().int().positive().optional(),name:z.string().trim().min(1).max(120),steps:z.array(engineStepSchema).min(1).max(20)}).strict(),
  z.object({kind:z.literal('plan.preview'),recipeId:id,recipeVersion:z.number().int().positive(),accountIds:z.array(id).min(1).max(500),mode:z.enum(['distributed','immediate']).default('distributed'),acknowledgeImmediate:z.boolean().default(false),windowSeconds:z.number().int().min(60).max(86400).default(3600)}).strict(),
  z.object({kind:z.literal('plan.confirm'),id,hash:z.string().regex(/^[a-f0-9]{64}$/),token:z.string().min(40).max(128),idempotencyKey:id}).strict(),
  z.object({kind:z.literal('campaign.cancel'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('action.cancel'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('action.reconcile'),id,version:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('chain.reset'),accountId:id,epoch:z.number().int().positive(),reason:z.string().trim().min(8).max(500)}).strict(),
]);
export type EngineCommand=z.input<typeof engineCommandSchema>;
export type ParsedEngineCommand=z.output<typeof engineCommandSchema>;
export interface RecipeRecord {id:string;name:string;version:number;steps:EngineStep[];}
export interface PlanTarget {accountId:string;alias:string;groupId:string;eligible:boolean;reason:string|null;offsets:number[];}
export interface ExecutionPlan {id:string;hash:string;token:string;expiresAt:string;recipeName:string;mode:'distributed'|'immediate';windowSeconds:number;targets:PlanTarget[];eligible:number;excluded:number;actions:number;estimatedSeconds:number;warnings:string[];}
export interface CampaignRecord {id:string;name:string;state:'QUEUED'|'RUNNING'|'SUCCEEDED'|'PARTIAL'|'CANCELLED'|'BLOCKED';mode:string;version:number;createdAt:string;deadline:string;cancelRequested:boolean;counts:Partial<Record<ActionState,number>>;}
export interface ActionRecord {id:string;accountId:string;alias:string;campaignId:string;step:number;kind:string;state:ActionState;version:number;attempts:number;earliestStart:string;deadline:string;cancelRequested:boolean;reason:string|null;epoch:number;}
export interface TransitionRecord {id:string;actionId:string;from:ActionState|null;to:ActionState;version:number;reason:string;createdAt:string;}
export interface EngineSnapshot {recipes:RecipeRecord[];campaigns:CampaignRecord[];actions:ActionRecord[];transitions:TransitionRecord[];total:number;offset:number;limit:number;metrics:{pending:number;inFlight:number;uncertain:number;outboxPending:number};engine:{available:boolean;lastTickAt:string|null;queue:'healthy'|'unavailable';concurrency:number;lastError:string|null};}
export interface EngineResult {snapshot?:EngineSnapshot;recipe?:RecipeRecord;plan?:ExecutionPlan;campaignId?:string;}
export interface EnginePort {run(command:EngineCommand):Promise<EngineResult>;}
