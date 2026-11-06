import type {EngineStep} from '@msm/contracts';
import type {AdapterDescription} from './planner.js';

export interface ActionContext {
  actionId:string;accountId:string;groupId:string;proxyId:string|null;attempt:number;leaseEpoch:number;
  /** Must commit the intent of an external effect before sending it. Throws on cancellation/fencing. */
  beforeEffect():Promise<void>;
  signal:AbortSignal;
}
export type ExecutionOutcome=
  | {kind:'SUCCEEDED';evidence?:{code:string}}
  | {kind:'SAFE_RETRY';retryAfterSeconds?:number;code:string}
  | {kind:'FAILED';code:string}
  | {kind:'UNCERTAIN';code:string};
export interface EngineAdapter extends AdapterDescription {
  execute(context:ActionContext):Promise<ExecutionOutcome>;
  /** Read-only reconciliation. No result supplied by the UI is accepted as evidence. */
  reconcile(context:Omit<ActionContext,'beforeEffect'>):Promise<'SUCCEEDED'|'NOT_APPLIED'|'UNKNOWN'>;
  /** Establishes that no old effect can still arrive and returns an inspected baseline. */
  fenceAndBaseline?(context:Omit<ActionContext,'beforeEffect'>):Promise<string|null>;
}
export type AdapterRegistry=ReadonlyMap<EngineStep['kind'],EngineAdapter>;
export const describe=(adapter:EngineAdapter):AdapterDescription=>({kind:adapter.kind,version:adapter.version,estimatedSeconds:adapter.estimatedSeconds,replaySafe:adapter.replaySafe});
