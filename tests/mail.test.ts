import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverTarget, DryRunMailProvider, GuardedLiveMailProvider, validateMailSnapshot, type MailSnapshot, type DeliveryState } from '../lib/mail';
const snapshot:MailSnapshot={idempotencyKey:'case-v1-company',recipient:'company@example.org',recipientVerified:true,body:'完整的报告正文'.repeat(100),pdf:Buffer.from('%PDF'+'.'.repeat(600)),version:1,snapshotId:'fixed',approvedSnapshotId:'fixed',reviewed:true,policy:'pending'};
test('mail boundary rejects missing approval, missing attachment and pending draft live delivery',()=>{
  assert.throws(()=>validateMailSnapshot({...snapshot,approvedSnapshotId:null},true));assert.throws(()=>validateMailSnapshot({...snapshot,pdf:Buffer.alloc(0)},true));assert.throws(()=>validateMailSnapshot({...snapshot,reviewed:false},true));assert.throws(()=>validateMailSnapshot({...snapshot,recipient:'client@aeconn.example'},true));assert.equal(new DryRunMailProvider().preview({...snapshot,reviewed:false}).label,'未发送 · dry-run');
});
test('partial delivery retains successful recipient and reconciles unknown after restart without retrying',async()=>{
  let calls=0;const state:DeliveryState[]=[];const provider=new GuardedLiveMailProvider(async value=>{calls++;if(value.recipient==='advisor@example.org')throw new Error('ambiguous timeout');return {status:'accepted'};},async()=>'delivered');
  const company=await deliverTarget(provider,snapshot,'pending',v=>state.push(v));assert.equal(company,'accepted');assert.deepEqual(state,['unknown','accepted']);
  const advisor=await deliverTarget(provider,{...snapshot,idempotencyKey:'case-v1-advisor',recipient:'advisor@example.org'},'pending',()=>{});assert.equal(advisor,'unknown');
  await deliverTarget(provider,snapshot,company,()=>{});assert.equal(calls,2);assert.equal(await deliverTarget(provider,snapshot,'unknown',()=>{}),'delivered');assert.equal(calls,2);
});
