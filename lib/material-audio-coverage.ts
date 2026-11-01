import { encodeRecordingWav, validateRecordingWav } from './recording-audio';
import { RECORDING_SAMPLE_RATE } from './recording-types';
import type { RecordingTranscriptionResult } from './recording-transcription';

export interface MaterialAudioGap {startSeconds:number;endSeconds:number}

const MIN_GAP_SECONDS=5;
const MIN_AUDIBLE_SECONDS=1;
const REPAIR_SECONDS=12;
const RMS_THRESHOLD=.01;
const RMS_WINDOW_SAMPLES=RECORDING_SAMPLE_RATE/4;

function normalizedGaps(gaps:MaterialAudioGap[]):MaterialAudioGap[]{
  const sorted=gaps.map(gap=>{
    if(!Number.isFinite(gap.startSeconds)||!Number.isFinite(gap.endSeconds)||gap.startSeconds<0||gap.endSeconds<=gap.startSeconds)throw new Error('音轨缺口范围无效。');
    return {...gap};
  }).sort((a,b)=>a.startSeconds-b.startSeconds||a.endSeconds-b.endSeconds);
  const merged:MaterialAudioGap[]=[];
  for(const gap of sorted){
    const previous=merged.at(-1);
    if(previous&&gap.startSeconds<=previous.endSeconds)previous.endSeconds=Math.max(previous.endSeconds,gap.endSeconds);
    else merged.push(gap);
  }
  return merged;
}

function audibleSamples(audio:Uint8Array,startSeconds:number,endSeconds:number):number {
  const view=new DataView(audio.buffer,audio.byteOffset,audio.byteLength);
  const startSample=Math.ceil(startSeconds*RECORDING_SAMPLE_RATE),endSample=Math.floor(endSeconds*RECORDING_SAMPLE_RATE);
  let audible=0;
  for(let start=startSample;start<endSample;start+=RMS_WINDOW_SAMPLES){
    const end=Math.min(start+RMS_WINDOW_SAMPLES,endSample);let energy=0;
    for(let index=start;index<end;index++){const sample=view.getInt16(44+index*2,true)/32768;energy+=sample*sample;}
    if(Math.sqrt(energy/(end-start))>=RMS_THRESHOLD)audible+=end-start;
  }
  return audible;
}

/** Energy only identifies intervals that deserve another check; it is not speech detection. */
export function materialAudioGaps(audio:Uint8Array,result:RecordingTranscriptionResult):MaterialAudioGap[]{
  if(result.timingWarning)return []; // Whole-chunk timing cannot prove sentence coverage.
  const {durationSeconds}=validateRecordingWav(audio);
  const coverage=result.segments.flatMap(segment=>{
    if(!Number.isFinite(segment.startSeconds)||!Number.isFinite(segment.endSeconds)||segment.startSeconds<0||segment.endSeconds<=segment.startSeconds||segment.startSeconds>=durationSeconds)return [];
    return [{startSeconds:segment.startSeconds,endSeconds:Math.min(segment.endSeconds,durationSeconds)}];
  }).sort((a,b)=>a.startSeconds-b.startSeconds||a.endSeconds-b.endSeconds);
  const merged:MaterialAudioGap[]=[];
  for(const range of coverage){
    const previous=merged.at(-1);
    if(previous&&range.startSeconds<=previous.endSeconds)previous.endSeconds=Math.max(previous.endSeconds,range.endSeconds);
    else merged.push({...range});
  }
  const missing:MaterialAudioGap[]=[];let cursor=0;
  for(const range of merged){if(range.startSeconds>cursor)missing.push({startSeconds:cursor,endSeconds:range.startSeconds});cursor=Math.max(cursor,range.endSeconds);}
  if(cursor<durationSeconds)missing.push({startSeconds:cursor,endSeconds:durationSeconds});
  return missing.filter(gap=>gap.endSeconds-gap.startSeconds>=MIN_GAP_SECONDS&&audibleSamples(audio,gap.startSeconds,gap.endSeconds)>=MIN_AUDIBLE_SECONDS*RECORDING_SAMPLE_RATE);
}

/** Backward-compatible tail warning used by the material review UI. */
export function materialAudioTailWarning(audio:Uint8Array,result:RecordingTranscriptionResult,offsetSeconds:number):string|undefined {
  const duration=validateRecordingWav(audio).durationSeconds;
  const gap=materialAudioGaps(audio,result).find(candidate=>Math.abs(candidate.endSeconds-duration)<1/RECORDING_SAMPLE_RATE);
  if(!gap)return;
  return `${(offsetSeconds+gap.startSeconds).toFixed(1)}–${(offsetSeconds+gap.endSeconds).toFixed(1)}s 音轨仍有声音，但没有对应转写；可能是背景音乐或漏识别，请对照原视频及字幕核对。`;
}

export function sliceMaterialAudio(audio:Uint8Array,startSeconds:number,endSeconds:number):Uint8Array {
  const {durationSeconds,sampleCount}=validateRecordingWav(audio);
  if(!Number.isFinite(startSeconds)||!Number.isFinite(endSeconds)||startSeconds<0||endSeconds<=startSeconds||endSeconds>durationSeconds+.5/RECORDING_SAMPLE_RATE)throw new Error('音轨裁剪范围无效。');
  const startSample=Math.round(startSeconds*RECORDING_SAMPLE_RATE),endSample=Math.round(endSeconds*RECORDING_SAMPLE_RATE);
  if(startSample<0||endSample>sampleCount||endSample<=startSample)throw new Error('音轨裁剪范围无效。');
  const source=new DataView(audio.buffer,audio.byteOffset,audio.byteLength),pcm=new Int16Array(endSample-startSample);
  for(let index=0;index<pcm.length;index++)pcm[index]=source.getInt16(44+(startSample+index)*2,true);
  return encodeRecordingWav(pcm);
}

export function planMaterialAudioRepairs(gaps:MaterialAudioGap[],maxAttempts=4):MaterialAudioGap[]{
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<0||maxAttempts>100)throw new Error('补提取次数无效。');
  const queue=normalizedGaps(gaps).map(gap=>({...gap,cursor:gap.startSeconds})),planned:MaterialAudioGap[]=[];
  while(planned.length<maxAttempts&&queue.some(gap=>gap.cursor<gap.endSeconds)){
    for(const gap of queue){
      if(planned.length>=maxAttempts)break;
      if(gap.cursor>=gap.endSeconds)continue;
      const endSeconds=Math.min(gap.cursor+REPAIR_SECONDS,gap.endSeconds);
      planned.push({startSeconds:gap.cursor,endSeconds});gap.cursor=endSeconds;
    }
  }
  return planned;
}

export function materialGapFrameTimes(gaps:MaterialAudioGap[],maxFrames=6):number[]{
  if(!Number.isSafeInteger(maxFrames)||maxFrames<0||maxFrames>100)throw new Error('补提取画面数量无效。');
  const candidates=normalizedGaps(gaps).map(gap=>{
    const times:number[]=[];
    for(let start=gap.startSeconds;start<gap.endSeconds;start+=3)times.push(Number((start+Math.min(1.5,(gap.endSeconds-start)/2)).toFixed(3)));
    return times;
  });
  const result:number[]=[];
  for(let index=0;result.length<maxFrames&&candidates.some(times=>index<times.length);index++)for(const times of candidates){if(result.length>=maxFrames)break;if(index<times.length)result.push(times[index]);}
  return result;
}
