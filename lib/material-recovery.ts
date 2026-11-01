import { createHash } from 'node:crypto';
import { UsageBudgetError } from './ai-usage';
import { extractMaterialImage } from './material-extractor';
import { materialAudioGaps, materialGapFrameTimes, planMaterialAudioRepairs, sliceMaterialAudio } from './material-audio-coverage';
import { transcribeRecordingChunk, type RecordingTranscriptionResult } from './recording-transcription';
import { extractMaterialVideoFrames } from './material-video-frames';
import type { MaterialAutoCheck, MaterialCheckIssue, MaterialProvider } from './material-types';

export const MATERIAL_MAX_AUDIO_REPAIRS=4;
export const MATERIAL_MAX_FRAME_REPAIRS=6;
export interface MaterialRecoveryAudio {position:number;startSeconds:number;endSeconds:number;audio:Uint8Array;transcription?:RecordingTranscriptionResult}
type Dependencies={transcribe?:typeof transcribeRecordingChunk;frames?:typeof extractMaterialVideoFrames;extractImage?:typeof extractMaterialImage};
type RecoveryInput={
  materialId:string;caseId:string;provider:MaterialProvider;audio:MaterialRecoveryAudio[];state?:MaterialAutoCheck;
  loadVideo:()=>{video:Uint8Array;mimeType:string};
  checkpoint:(state:MaterialAutoCheck,action:string,detail:string)=>void;
};
const interval=(start:number,end:number)=>`${start.toFixed(1)}–${end.toFixed(1)}s`;
function safeFailure(error:unknown){return error instanceof UsageBudgetError?'本次补提取受到现有调用额度限制，已停止后续自动调用。':'本次补提取未完成；结果或费用可能尚未确认，已停止后续自动调用。';}
function wholePartPlan(part:MaterialRecoveryAudio){return planMaterialAudioRepairs([{startSeconds:0,endSeconds:part.endSeconds-part.startSeconds}],MATERIAL_MAX_AUDIO_REPAIRS);}
function representativePartPlans<T extends {clips:unknown[]}>(plans:T[]){
  const candidates=plans.filter(plan=>plan.clips.length);
  if(candidates.length<=MATERIAL_MAX_AUDIO_REPAIRS)return candidates;
  return Array.from({length:MATERIAL_MAX_AUDIO_REPAIRS},(_,index)=>candidates[Math.round(index*(candidates.length-1)/(MATERIAL_MAX_AUDIO_REPAIRS-1))]);
}
function uncoveredRanges(durationSeconds:number,ranges:Array<{startSeconds:number;endSeconds:number}>){
  const merged=ranges.filter(range=>Number.isFinite(range.startSeconds)&&Number.isFinite(range.endSeconds)&&range.startSeconds>=0&&range.endSeconds>range.startSeconds&&range.startSeconds<durationSeconds)
    .map(range=>({startSeconds:range.startSeconds,endSeconds:Math.min(durationSeconds,range.endSeconds)})).sort((a,b)=>a.startSeconds-b.startSeconds||a.endSeconds-b.endSeconds)
    .reduce<Array<{startSeconds:number;endSeconds:number}>>((result,range)=>{const previous=result.at(-1);if(previous&&range.startSeconds<=previous.endSeconds+.05)previous.endSeconds=Math.max(previous.endSeconds,range.endSeconds);else result.push(range);return result;},[]);
  const missing:Array<{startSeconds:number;endSeconds:number}>=[];let cursor=0;
  for(const range of merged){if(range.startSeconds-cursor>.25)missing.push({startSeconds:cursor,endSeconds:range.startSeconds});cursor=Math.max(cursor,range.endSeconds);}
  if(durationSeconds-cursor>.25)missing.push({startSeconds:cursor,endSeconds:durationSeconds});
  return missing;
}
function savedPreviousText(input:RecoveryInput,current:MaterialAutoCheck,part:MaterialRecoveryAudio,startSeconds:number){
  const prior=current.audio.filter(attempt=>attempt.partPosition===part.position&&attempt.status==='done'&&Math.abs(attempt.endSeconds-startSeconds)<=.1&&attempt.result?.segments.length)
    .sort((a,b)=>b.endSeconds-a.endSeconds)[0];
  if(prior?.result)return prior.result.segments.map(segment=>segment.text).join(' ');
  if(startSeconds>.05)return;
  const previous=input.audio.filter(candidate=>Math.abs(candidate.endSeconds-part.startSeconds)<=.1).sort((a,b)=>b.endSeconds-a.endSeconds)[0];
  if(!previous)return;
  const previousDuration=previous.endSeconds-previous.startSeconds;
  const recovered=current.audio.filter(attempt=>attempt.partPosition===previous.position&&attempt.status==='done'&&Math.abs(attempt.endSeconds-previousDuration)<=.1&&attempt.result?.segments.length).sort((a,b)=>b.endSeconds-a.endSeconds)[0];
  return recovered?.result?.segments.map(segment=>segment.text).join(' ')??previous.transcription?.segments.map(segment=>segment.text).join(' ');
}

/** Checkpoints precede chargeable calls. A started attempt is never automatically replayed. */
export async function recoverMaterialCoverage(input:RecoveryInput,dependencies:Dependencies={}):Promise<MaterialAutoCheck>{
  const current=input.state??{version:1,status:'running',audio:[],frames:[],issues:[]} as MaterialAutoCheck;
  if(current.status!=='running')return current;
  const save=(action:string,detail:string)=>input.checkpoint(current,action,detail);
  const transcribe=dependencies.transcribe??transcribeRecordingChunk;
  const decodeFrames=dependencies.frames??extractMaterialVideoFrames;
  const extractImage=dependencies.extractImage??extractMaterialImage;
  if([...current.audio,...current.frames].some(attempt=>attempt.status==='started')){
    current.stoppedReason='上次补提取中断，不能确认是否已完成或收费；保留记录，不自动重放。';
    for(const attempt of [...current.audio,...current.frames])if(attempt.status==='started'){attempt.status='failed';attempt.error=current.stoppedReason;}
  }
  save('auto_check_started','自动检查转写的时间覆盖；有声音不等于有人声，未发现缺口也不代表逐字准确。');
  const partPlans=representativePartPlans(input.audio.map(part=>({part,clips:!part.transcription||part.transcription.timingWarning?wholePartPlan(part):planMaterialAudioRepairs(materialAudioGaps(part.audio,part.transcription),MATERIAL_MAX_AUDIO_REPAIRS)})));
  // Share the finite attempts across audio parts so an early gap cannot consume
  // every attempt before the middle or end of the video gets a turn.
  const plan=Array.from({length:MATERIAL_MAX_AUDIO_REPAIRS},(_,index)=>partPlans.flatMap(({part,clips})=>clips[index]?[{part,clip:clips[index]}]:[])).flat().slice(0,MATERIAL_MAX_AUDIO_REPAIRS);
  for(const {part,clip} of plan){
      if(current.stoppedReason)break;
      if(current.audio.length>=MATERIAL_MAX_AUDIO_REPAIRS)break;
      const key=`${part.position}:${clip.startSeconds.toFixed(5)}:${clip.endSeconds.toFixed(5)}`;
      if(current.audio.some(attempt=>attempt.key===key))continue;
      const attempt:MaterialAutoCheck['audio'][number]={key,partPosition:part.position,startSeconds:clip.startSeconds,endSeconds:clip.endSeconds,status:'started'};
      current.audio.push(attempt);
      save('audio_repair_started',`自动补转写 ${interval(part.startSeconds+clip.startSeconds,part.startSeconds+clip.endSeconds)}；限次，不重做其他已完成片段。`);
      try{
        attempt.result=await transcribe({audio:sliceMaterialAudio(part.audio,clip.startSeconds,clip.endSeconds),context:{caseId:input.caseId,sessionId:`material:${input.materialId}:repair:${key}`},provider:input.provider,allowChunkTimingFallback:true,previousText:savedPreviousText(input,current,part,clip.startSeconds)});
        attempt.status='done';
      }catch(error){attempt.status='failed';attempt.error=safeFailure(error);current.stoppedReason=attempt.error;}
      save(attempt.status==='done'?'audio_repair_completed':'audio_repair_stopped',`补转写 ${interval(part.startSeconds+clip.startSeconds,part.startSeconds+clip.endSeconds)}：${attempt.status==='done'?'已保存结果，继续检查覆盖。':attempt.error}`);
      if(current.stoppedReason)break;
  }
  const unresolved:MaterialCheckIssue[]=[];
  for(const part of input.audio){
    const recovered=current.audio.filter(attempt=>attempt.partPosition===part.position&&attempt.status==='done'&&attempt.result&&!attempt.result.timingWarning).flatMap(attempt=>attempt.result!.segments.map(segment=>({...segment,startSeconds:attempt.startSeconds+segment.startSeconds,endSeconds:attempt.startSeconds+segment.endSeconds})));
    if(!part.transcription||part.transcription.timingWarning){
      for(const gap of uncoveredRanges(part.endSeconds-part.startSeconds,recovered))unresolved.push({startSeconds:part.startSeconds+gap.startSeconds,endSeconds:part.startSeconds+gap.endSeconds,message:part.transcription?'原转写只有整段时间；未覆盖区间仍需核对。':'旧资料缺少可核对的逐句时间；未覆盖区间仍需核对。'});
      if(!part.transcription&&!unresolved.some(issue=>issue.startSeconds>=part.startSeconds&&issue.endSeconds<=part.endSeconds&&issue.message.startsWith('旧资料缺少')))unresolved.push({startSeconds:part.startSeconds,endSeconds:part.endSeconds,message:'旧资料缺少首轮逐句时间元数据；自动补转写单独保留，仍须对照原视频。'});
      for(const attempt of current.audio.filter(attempt=>attempt.partPosition===part.position&&attempt.result?.timingWarning))unresolved.push({startSeconds:part.startSeconds+attempt.startSeconds,endSeconds:part.startSeconds+attempt.endSeconds,message:'补转写文字已保留，但逐句时间无法确认。'});
      continue;
    }
    for(const gap of materialAudioGaps(part.audio,{...part.transcription,segments:[...part.transcription.segments,...recovered]}))unresolved.push({startSeconds:part.startSeconds+gap.startSeconds,endSeconds:part.startSeconds+gap.endSeconds,message:'音轨仍有声音但缺少可靠转写，可能是音乐或漏识别。'});
    for(const attempt of current.audio.filter(attempt=>attempt.partPosition===part.position&&attempt.result?.timingWarning))unresolved.push({startSeconds:part.startSeconds+attempt.startSeconds,endSeconds:part.startSeconds+attempt.endSeconds,message:'补转写文字已保留，但逐句时间无法确认。'});
  }
  // A small set of frame samples can recover subtitles, but cannot certify all speech.
  const frameGaps=unresolved.filter(issue=>issue.message.startsWith('音轨仍有声音')||issue.message.includes('未覆盖区间'));
  const frameTimes=materialGapFrameTimes(frameGaps,MATERIAL_MAX_FRAME_REPAIRS).filter(time=>!current.frames.some(frame=>frame.timeSeconds===time)).slice(0,Math.max(0,MATERIAL_MAX_FRAME_REPAIRS-current.frames.length));
  if(frameTimes.length&&!current.stoppedReason&&input.provider==='openai'){
    const times=frameTimes;
    try{
      const source=input.loadVideo();current.sourceSha256=createHash('sha256').update(source.video).digest('hex');
      const images=await decodeFrames({...source,times});
      if(images.length!==times.length||images.some((frame,index)=>frame.timeSeconds!==times[index]))throw new Error('Unexpected frames');
      for(const frame of images){
        const attempt:MaterialAutoCheck['frames'][number]={timeSeconds:frame.timeSeconds,status:'started',imageSha256:createHash('sha256').update(frame.image).digest('hex')};
        current.frames.push(attempt);save('frame_repair_started',`自动补识别约 ${frame.timeSeconds.toFixed(1)}s 的画面字幕。`);
        try{attempt.text=(await extractImage({image:frame.image,mimeType:frame.mimeType,context:{caseId:input.caseId,sessionId:`material:${input.materialId}:repair:frame:${frame.timeSeconds.toFixed(5)}`},provider:input.provider,purpose:'video_gap'})).text;attempt.status='done';}
        catch(error){attempt.status='failed';attempt.error=safeFailure(error);current.stoppedReason=attempt.error;}
        save(attempt.status==='done'?'frame_repair_completed':'frame_repair_stopped',`画面约 ${frame.timeSeconds.toFixed(1)}s：${attempt.status==='done'?'补提取已保存，来源为画面，不作为语音原文。':attempt.error}`);
        if(current.stoppedReason)break;
      }
    }catch{
      current.stoppedReason??='本机无法读取补充画面，已保留音轨结果和待核对区间。';
      save('frame_repair_unavailable',current.stoppedReason);
    }
  }
  current.issues=unresolved.map(issue=>({...issue,message:issue.message+(current.frames.some(frame=>frame.status==='done'&&frame.timeSeconds>=issue.startSeconds&&frame.timeSeconds<=issue.endSeconds)?' 已补充抽样字幕，仍不能确认全部语音完整。':'')}));
  if(current.stoppedReason&&!current.issues.length)current.issues.push({startSeconds:0,endSeconds:Math.max(0,...input.audio.map(part=>part.endSeconds)),message:current.stoppedReason});
  current.status=current.issues.length?'attention':current.audio.length||current.frames.length?'supplemented':'checked';
  save('auto_check_completed',`自动检查结束；补转写 ${current.audio.filter(item=>item.status==='done').length} 段、补画面 ${current.frames.filter(item=>item.status==='done').length} 张；${current.issues.length?`剩余 ${current.issues.length} 处需重点核对。`:'未发现明显时间缺口；不等于内容已审核。'}`);
  return current;
}

export function materialRecoveryText(check:MaterialAutoCheck,audio:MaterialRecoveryAudio[]):string{
  const sections:string[]=[];
  for(const attempt of check.audio){
    if(attempt.status!=='done'||!attempt.result?.segments.length)continue;
    const part=audio.find(item=>item.position===attempt.partPosition);if(!part)continue;
    const lines=attempt.result.segments.map(segment=>`[${interval(part.startSeconds+attempt.startSeconds+segment.startSeconds,part.startSeconds+attempt.startSeconds+segment.endSeconds)}] ${segment.text}`);
    sections.push(`### 自动补转写 ${interval(part.startSeconds+attempt.startSeconds,part.startSeconds+attempt.endSeconds)}\n${attempt.result.timingWarning?`【${attempt.result.timingWarning}】\n`:''}${lines.join('\n')}`);
  }
  for(const attempt of check.frames)if(attempt.status==='done'&&attempt.text)sections.push(`### 自动补画面约 ${attempt.timeSeconds.toFixed(1)}s（画面文字，非语音原文）\n${attempt.text}`);
  if(check.issues.length)sections.push(`### 自动检查仍需注意\n${check.issues.map(issue=>`- ${interval(issue.startSeconds,issue.endSeconds)}：${issue.message}`).join('\n')}`);
  if(check.stoppedReason)sections.push(`处理限制：${check.stoppedReason}`);
  return sections.length?`\n\n## 自动检查与补提取（原始结果保留在上方）\n\n${sections.join('\n\n')}`:'';
}
