import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverMaterialCoverage, materialRecoveryText, type MaterialRecoveryAudio } from '../lib/material-recovery';
import { encodeRecordingWav, validateRecordingWav } from '../lib/recording-audio';
import { UsageBudgetError } from '../lib/ai-usage';
import type { MaterialAutoCheck } from '../lib/material-types';

function audioPart(position=0,startSeconds=60,duration=20):MaterialRecoveryAudio {
  return {position,startSeconds,endSeconds:startSeconds+duration,audio:encodeRecordingWav(new Int16Array(16000*duration).fill(4000)),transcription:{durationSeconds:duration,segments:[{startSeconds:0,endSeconds:4,text:'原始前段'}]}};
}
function fixture(audio=[audioPart()]){
  const checkpoints:Array<{state:MaterialAutoCheck;action:string}>=[];
  return {checkpoints,input:{materialId:'material-test',caseId:'case-test',provider:'openai' as const,audio,loadVideo:()=>({video:new Uint8Array([1,2,3]),mimeType:'video/mp4'}),checkpoint:(state:MaterialAutoCheck,action:string)=>{checkpoints.push({state:structuredClone(state),action});}}};
}
const noFrames=async():Promise<never>=>{throw new Error('Frames should not be requested');};

test('automatic repair keeps source offsets, writes ahead, and never repeats completed attempts',async()=>{
  const {input,checkpoints}=fixture();let calls=0;
  const result=await recoverMaterialCoverage(input,{frames:noFrames,transcribe:async request=>{
    calls++;assert.equal(checkpoints.at(-1)!.action,'audio_repair_started');assert.equal(checkpoints.at(-1)!.state.audio.at(-1)!.status,'started');
    const {durationSeconds}=validateRecordingWav(request.audio);assert(durationSeconds<=12);
    return {durationSeconds,segments:[{startSeconds:0,endSeconds:durationSeconds,text:`补回 ${calls}`} ]};
  }});
  assert.equal(calls,2);assert.equal(result.status,'supplemented');assert.deepEqual(result.issues,[]);
  assert.match(materialRecoveryText(result,input.audio),/64.0–76.0s/);assert.match(materialRecoveryText(result,input.audio),/76.0–80.0s/);
  assert.equal(input.audio[0].transcription!.segments.length,1,'original remains unchanged');
  await recoverMaterialCoverage({...input,state:result},{transcribe:async()=>{throw Error('must not replay');},frames:noFrames});assert.equal(calls,2);
});

test('unresolved audio gets bounded subtitle samples, preserving uncertain speech and hashes',async()=>{
  const {input,checkpoints}=fixture();let audioCalls=0,imageCalls=0;
  const result=await recoverMaterialCoverage(input,{
    transcribe:async request=>{audioCalls++;return {durationSeconds:validateRecordingWav(request.audio).durationSeconds,segments:[]};},
    frames:async request=>{assert(request.times.length<=6);assert(request.times.every(time=>time>64&&time<80));return request.times.map(timeSeconds=>({timeSeconds,image:new Uint8Array([255,216,255,1]),mimeType:'image/jpeg' as const}));},
    extractImage:async()=>{imageCalls++;assert.equal(checkpoints.at(-1)!.action,'frame_repair_started');return {text:'画面字幕：受益人填写',provider:'openai'};},
  });
  assert.equal(audioCalls,2);assert(imageCalls>0&&imageCalls<=6);assert.equal(result.status,'attention');assert.match(result.issues[0].message,/已补充抽样字幕/);
  assert.match(result.sourceSha256!,/^[a-f0-9]{64}$/);assert(result.frames.every(frame=>frame.imageSha256?.length===64));
  assert.match(materialRecoveryText(result,input.audio),/画面文字，非语音原文/);
});

test('budget refusal or uncertain network failure stops all further paid attempts and retains evidence',async()=>{
  for(const error of [new UsageBudgetError('limit'),new Error('private upstream failure')]){
    const {input}=fixture();let calls=0,images=0;
    const result=await recoverMaterialCoverage(input,{transcribe:async()=>{calls++;throw error;},frames:async()=>{images++;return [];}});
    assert.equal(calls,1);assert.equal(images,0);assert.equal(result.audio[0].status,'failed');assert.equal(result.status,'attention');
    assert(result.stoppedReason);assert(!JSON.stringify(result).includes('private upstream failure'));
    await recoverMaterialCoverage({...input,state:result},{transcribe:async()=>{calls++;throw error;}});assert.equal(calls,1);
  }
});

test('started attempts surviving restart are recorded as uncertain and never replayed',async()=>{
  const {input}=fixture();const state:MaterialAutoCheck={version:1,status:'running',audio:[{key:'0:4.00000:16.00000',partPosition:0,startSeconds:4,endSeconds:16,status:'started'}],frames:[],issues:[]};
  const result=await recoverMaterialCoverage({...input,state},{transcribe:async()=>{assert.fail('uncertain requests must not replay');},frames:noFrames});
  assert.equal(result.audio.length,1);assert.equal(result.audio[0].status,'failed');assert.equal(result.status,'attention');assert.match(result.stoppedReason!,/不自动重放/);
});

test('per-material retry cap spans multiple audio parts and does not fabricate gap completion',async()=>{
  const {input}=fixture([audioPart(0,0,30),audioPart(1,30,30),audioPart(2,60,30)]);let calls=0;
  const result=await recoverMaterialCoverage(input,{transcribe:async request=>{calls++;return {durationSeconds:validateRecordingWav(request.audio).durationSeconds,segments:[]};},frames:async()=>{throw Error('Unavailable on this platform');}});
  assert.equal(calls,4);assert.equal(result.audio.length,4);assert.equal(result.status,'attention');assert.equal(result.issues.length,3);assert.match(result.stoppedReason!,/无法读取/);
  assert.deepEqual(result.audio.map(attempt=>attempt.partPosition),[0,1,2,0],'repair allowance is shared across the video, including its tail');
});

test('more than four suspect audio parts share four attempts across the full timeline including the tail',async()=>{
  const audio=Array.from({length:7},(_,index)=>{const part=audioPart(index,index*15,15);part.transcription!.timingWarning='整段时间';return part;});const {input}=fixture(audio);const positions:number[]=[];
  const result=await recoverMaterialCoverage(input,{transcribe:async request=>{positions.push(Number(request.context.sessionId?.split(':')[3]));return {durationSeconds:validateRecordingWav(request.audio).durationSeconds,segments:[]};},frames:async()=>{throw Error('Unavailable on this platform');}});
  assert.deepEqual(positions,[0,2,4,6]);assert.equal(result.audio.length,4);assert.equal(result.status,'attention');assert.equal(result.issues.length,7);assert.match(result.stoppedReason!,/无法读取/);
  assert(result.issues.some(issue=>issue.startSeconds===90&&issue.endSeconds===105),'unrepaired tail remains explicitly reviewable');
});

test('no gaps makes no calls, while coarse timestamps get bounded repair and retain uncovered intervals',async()=>{
  const complete=audioPart();complete.transcription!.segments[0].endSeconds=20;
  const checked=await recoverMaterialCoverage(fixture([complete]).input,{transcribe:async()=>{assert.fail('no calls needed');},frames:noFrames});assert.equal(checked.status,'checked');
  const coarse=audioPart();coarse.transcription!.timingWarning='仅整段时间';
  let calls=0;
  const attention=await recoverMaterialCoverage(fixture([coarse]).input,{transcribe:async request=>{calls++;const duration=validateRecordingWav(request.audio).durationSeconds;return {durationSeconds:duration,segments:[{startSeconds:0,endSeconds:Math.min(4,duration),text:`粗时间补回 ${calls}`} ]};},frames:async()=>{throw Error('Unavailable on this platform');}});
  assert.equal(calls,2);assert.equal(attention.status,'attention');assert.match(attention.issues.map(issue=>issue.message).join(' '),/原转写只有整段时间.*未覆盖区间/);
  assert.equal(coarse.transcription!.segments[0].text,'原始前段','coarse original remains unchanged');
});

test('coarse and missing timing share the global cap, carry only saved adjacent context, and stop safely on restart',async()=>{
  const coarseA=audioPart(0,0,20);coarseA.transcription!.timingWarning='整段时间';coarseA.transcription!.segments[0].text='前一音轨已保存文字';
  const coarseB=audioPart(1,20,20);coarseB.transcription=undefined;
  const {input}=fixture([coarseA,coarseB]);const positions:number[]=[];const prompts:Array<string|undefined>=[];
  const result=await recoverMaterialCoverage(input,{transcribe:async request=>{positions.push(Number(request.context.sessionId?.split(':')[3]));prompts.push(request.previousText);const duration=validateRecordingWav(request.audio).durationSeconds;return {durationSeconds:duration,segments:[{startSeconds:0,endSeconds:duration,text:`已保存补回 ${positions.length}`} ]};},frames:noFrames});
  assert.deepEqual(positions,[0,1,0,1]);assert.equal(result.audio.length,4);assert.equal(result.status,'attention');
  assert.equal(prompts[0],undefined);assert.equal(prompts[1],'前一音轨已保存文字');assert.equal(prompts[2],'已保存补回 1');assert.equal(prompts[3],'已保存补回 2');
  assert(result.issues.some(issue=>issue.message.includes('旧资料缺少首轮逐句时间元数据')));
  const interrupted:MaterialAutoCheck={version:1,status:'running',audio:[{key:'0:0.00000:12.00000',partPosition:0,startSeconds:0,endSeconds:12,status:'started'}],frames:[],issues:[]};let replayed=0;
  const stopped=await recoverMaterialCoverage({...input,state:interrupted},{transcribe:async()=>{replayed++;throw Error('must not replay');},frames:noFrames});
  assert.equal(replayed,0);assert.match(stopped.stoppedReason!,/不自动重放/);assert.equal(stopped.status,'attention');
});

test('coarse timing respects a budget refusal before any later repair or frame request',async()=>{
  const coarse=audioPart();coarse.transcription!.timingWarning='整段时间';const {input}=fixture([coarse]);let calls=0,frameCalls=0;
  const result=await recoverMaterialCoverage(input,{transcribe:async()=>{calls++;throw new UsageBudgetError('limit');},frames:async()=>{frameCalls++;return [];}});
  assert.equal(calls,1);assert.equal(frameCalls,0);assert.equal(result.audio.length,1);assert.equal(result.audio[0].status,'failed');assert.match(result.stoppedReason!,/额度限制/);
  await recoverMaterialCoverage({...input,state:result},{transcribe:async()=>{calls++;throw Error('must not replay');}});assert.equal(calls,1);
});

test('context is never borrowed across a non-adjacent source gap',async()=>{
  const first=audioPart(0,0,12);first.transcription!.timingWarning='整段时间';const later=audioPart(1,20,12);later.transcription!.timingWarning='整段时间';const prompts:Array<string|undefined>=[];
  await recoverMaterialCoverage(fixture([first,later]).input,{transcribe:async request=>{prompts.push(request.previousText);const duration=validateRecordingWav(request.audio).durationSeconds;return {durationSeconds:duration,segments:[{startSeconds:0,endSeconds:duration,text:`补回 ${prompts.length}`} ]};},frames:noFrames});
  assert.deepEqual(prompts,[undefined,undefined]);
});

test('context is never borrowed across separate gaps inside one audio part',async()=>{
  const part=audioPart(0,0,30);part.transcription={durationSeconds:30,segments:[{startSeconds:0,endSeconds:4,text:'开头'},{startSeconds:16,endSeconds:20,text:'中段'}]};const prompts:Array<string|undefined>=[];
  await recoverMaterialCoverage(fixture([part]).input,{transcribe:async request=>{prompts.push(request.previousText);const duration=validateRecordingWav(request.audio).durationSeconds;return {durationSeconds:duration,segments:[{startSeconds:0,endSeconds:duration,text:`补回 ${prompts.length}`} ]};},frames:noFrames});
  assert.deepEqual(prompts,[undefined,undefined]);
});

test('a partial repair from the prior part is not used as boundary context',async()=>{
  const first=audioPart(0,0,20);first.transcription=undefined;const next=audioPart(1,20,12);next.transcription!.timingWarning='整段时间';const prompts:Array<string|undefined>=[];
  await recoverMaterialCoverage(fixture([first,next]).input,{transcribe:async request=>{prompts.push(request.previousText);const duration=validateRecordingWav(request.audio).durationSeconds;return {durationSeconds:duration,segments:[{startSeconds:0,endSeconds:duration,text:`补回 ${prompts.length}`} ]};},frames:noFrames});
  assert.equal(prompts[1],undefined,'the first part repair ends at 12s, before its 20s boundary');
});

test('restart after a completed frame resumes only remaining samples within the original cap',async()=>{
  const {input}=fixture();
  const state:MaterialAutoCheck={version:1,status:'running',audio:[
    {key:'0:4.00000:16.00000',partPosition:0,startSeconds:4,endSeconds:16,status:'done',result:{durationSeconds:12,segments:[]}},
    {key:'0:16.00000:20.00000',partPosition:0,startSeconds:16,endSeconds:20,status:'done',result:{durationSeconds:4,segments:[]}},
  ],frames:[{timeSeconds:65.5,status:'done',text:'已保存的画面字幕'}],issues:[]};
  let imageCalls=0;
  const result=await recoverMaterialCoverage({...input,state},{transcribe:async()=>{assert.fail('completed audio must not replay');},
    frames:async request=>{assert(!request.times.includes(65.5));return request.times.map(timeSeconds=>({timeSeconds,image:new Uint8Array([255,216,255,1]),mimeType:'image/jpeg' as const}));},
    extractImage:async()=>{imageCalls++;return {text:'剩余画面字幕',provider:'openai'};},
  });
  assert.equal(result.frames.length,6);assert.equal(imageCalls,5);assert.equal(result.frames[0].text,'已保存的画面字幕');
});
