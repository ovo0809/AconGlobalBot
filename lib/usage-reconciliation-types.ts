export type ReconciliationMethod='manual'|'automatic';

export interface ReconciliationPendingCall {
  id:string;
  operation:string;
  model:string;
  createdAt:string;
  closedAt:string|null;
  status:'unknown'|'reserved';
  recordedMicros:number;
  reservedMicros:number;
  heldMicros:number;
  version:string;
  automaticReady:boolean;
}

export interface ReconciliationHistoryItem {
  id:string;
  callId:string;
  method:ReconciliationMethod;
  recordedMicros:number;
  confirmedMicros:number;
  accountedMicros:number;
  releasedMicros:number;
  evidenceRef:string;
  note:string;
  createdAt:string;
  actorId:string|null;
}

export interface ReconciliationOverview {
  limits:{caseMicros:number;dailyMicros:number;monthlyMicros:number};
  pending:ReconciliationPendingCall[];
  history:ReconciliationHistoryItem[];
}

export interface ManualSettlementInput {
  orgId:string;
  actorId:string;
  callId:string;
  version:string;
  amountUsd:string;
  evidenceRef:string;
  note:string;
}

export interface ManualSettlementPreview {
  callId:string;
  version:string;
  recordedMicros:number;
  confirmedMicros:number;
  accountedMicros:number;
  releasedMicros:number;
  evidenceRef:string;
  note:string;
}

export interface ManualSettlementCommitInput extends ManualSettlementInput {
  requestId:string;
  confirmed:true;
}
