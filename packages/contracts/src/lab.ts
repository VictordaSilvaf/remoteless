import {z} from 'zod';

const id = z.uuid();
export const labLocatorSchema = z.object({by:z.enum(['testId','css']),value:z.string().min(1).max(300)}).strict();
export const labStepSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('navigate'),url:z.url().max(1000)}).strict(),
  z.object({kind:z.literal('click'),target:labLocatorSchema}).strict(),
  z.object({kind:z.literal('fill'),target:labLocatorSchema,value:z.string().max(500)}).strict(),
  z.object({kind:z.literal('assert'),target:labLocatorSchema,text:z.string().max(500)}).strict(),
]);
export type LabStep = z.infer<typeof labStepSchema>;
export const labCommandSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('create'),label:z.string().min(1).max(50),url:z.url().max(1000)}).strict(),
  z.object({kind:z.literal('open'),accountId:id}).strict(),
  z.object({kind:z.literal('close'),accountId:id}).strict(),
  z.object({kind:z.literal('room'),accountIds:z.array(id).min(1).max(4),leaderId:id,mirror:z.boolean()}).strict(),
  z.object({kind:z.literal('input'),accountId:id,input:z.discriminatedUnion('type',[
    z.object({type:z.literal('click'),x:z.number().min(0).max(719),y:z.number().min(0).max(479)}).strict(),
    z.object({type:z.literal('text'),value:z.string().max(500)}).strict(),
    z.object({type:z.literal('key'),key:z.enum(['Enter','Tab','Backspace','Escape','ArrowUp','ArrowDown'])}).strict(),
    z.object({type:z.literal('scroll'),deltaY:z.number().min(-1000).max(1000)}).strict(),
  ])}).strict(),
  z.object({kind:z.literal('step'),accountId:id,step:labStepSchema,mirror:z.boolean().default(false)}).strict(),
  z.object({kind:z.literal('checkpoint'),accountId:id}).strict(),
  z.object({kind:z.literal('simulate'),accountIds:z.array(id).min(1).max(10),steps:z.array(labStepSchema).min(1).max(12),windowSeconds:z.number().int().min(0).max(3600)}).strict(),
  z.object({kind:z.literal('confirm'),planId:id,hash:z.string().length(64)}).strict(),
  z.object({kind:z.literal('cancel'),batchId:id}).strict(),
  z.object({kind:z.literal('restartBrowser')}).strict(),
]);
export type LabCommand = z.infer<typeof labCommandSchema>;
export interface LabFrame {accountId:string;sequence:number;createdAt:number;width:number;height:number;jpeg:string;}
export interface LabAccount {id:string;label:string;url:string;state:'dormant'|'opening'|'visible'|'background'|'blocked';hasSnapshot:boolean;version:number;error?:string;}
export interface LabActionResult {accountId:string;state:'succeeded'|'failed'|'unknown';durationMs:number;code?:string;}
export interface LabPlan {id:string;hash:string;accountIds:string[];steps:LabStep[];actionCount:number;windowSeconds:number;expiresAt:number;}
export interface LabBatch {id:string;state:'running'|'completed'|'partial'|'cancelled'|'interrupted';total:number;completed:number;results:LabActionResult[];cancelRequested:boolean;}
export interface LabMetrics {rssBytes:number;memoryBytes:number;cpuMs:number;contexts:number;frames:number;frameBytes:number;latencyMs:number[];uptimeSeconds:number;}
export interface LabStatus {available:true;accounts:LabAccount[];room:{accountIds:string[];leaderId:string|null;mirror:boolean};batches:LabBatch[];metrics:LabMetrics;limits:{visible:4;background:2,total:6};}
export interface LabResult {status:LabStatus;accountId?:string;results?:LabActionResult[];recordedStep?:LabStep;plan?:LabPlan;batchId?:string;}
export interface LabPort {status():Promise<LabStatus>;command(command:LabCommand):Promise<LabResult>;frame(accountId:string):Promise<LabFrame|null>;}
