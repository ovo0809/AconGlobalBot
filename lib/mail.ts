/** Mail transport boundary. There is deliberately no configured live sender in this demo. */
export type DeliveryState='pending'|'dry_run'|'accepted'|'delivered'|'failed'|'unknown';
export interface MailSnapshot { idempotencyKey:string;recipient:string;recipientVerified:boolean;body:string;pdf:Uint8Array;version:number;snapshotId:string;approvedSnapshotId:string|null;reviewed:boolean;policy:'pending'|'allow'|'reviewed_only' }
export interface MailPreview { recipient:string;body:string;pdf:Uint8Array;label:'未发送 · dry-run' }
export interface MailProvider { preview(snapshot:MailSnapshot):MailPreview;send(snapshot:MailSnapshot):Promise<{status:DeliveryState;providerId?:string}>;reconcile?(idempotencyKey:string):Promise<DeliveryState> }
export class DryRunMailProvider implements MailProvider {
  preview(snapshot:MailSnapshot):MailPreview {validateMailSnapshot(snapshot,false);return {recipient:snapshot.recipient,body:snapshot.body,pdf:snapshot.pdf,label:'未发送 · dry-run'};}
  async send(snapshot:MailSnapshot){this.preview(snapshot);return {status:'dry_run' as const};}
}
export function validateMailSnapshot(snapshot:MailSnapshot,live:boolean){
  if(!snapshot.approvedSnapshotId||snapshot.snapshotId!==snapshot.approvedSnapshotId)throw new Error('发送批准未绑定当前快照。');
  if(snapshot.body.length<200||snapshot.pdf.length<500||Buffer.from(snapshot.pdf).subarray(0,4).toString()!=='%PDF')throw new Error('完整正文与真实 PDF 附件缺一不可。');
  if(live&&(!snapshot.recipientVerified||/\.(example|invalid)$/.test(snapshot.recipient)))throw new Error('真实收件人未核验。');
  if(live&&!snapshot.reviewed&&snapshot.policy!=='allow')throw new Error('未复核草稿真实发送政策不允许。');
}
/** Implementations must use a vendor idempotency key and return accepted separately from delivered. */
export class GuardedLiveMailProvider implements MailProvider {
  constructor(private transport:(snapshot:MailSnapshot)=>Promise<{status:DeliveryState;providerId?:string}>,private lookup:(key:string)=>Promise<DeliveryState>){}
  preview(snapshot:MailSnapshot){return new DryRunMailProvider().preview(snapshot);}
  async send(snapshot:MailSnapshot){validateMailSnapshot(snapshot,true);return this.transport(snapshot);}
  reconcile(key:string){return this.lookup(key);}
}
/** Caller persists `unknown` BEFORE the network call; restart must reconcile it, never blindly retry. */
export async function deliverTarget(provider:MailProvider,snapshot:MailSnapshot,current:DeliveryState,persist:(state:DeliveryState)=>void):Promise<DeliveryState>{
  if(['accepted','delivered','dry_run'].includes(current))return current;
  if(current==='unknown'){const state=await provider.reconcile?.(snapshot.idempotencyKey)??'unknown';persist(state);return state;}
  persist('unknown');
  try{const result=await provider.send(snapshot);persist(result.status);return result.status;}catch{persist('unknown');return 'unknown';}
}
