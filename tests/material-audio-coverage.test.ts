import assert from 'node:assert/strict';
import test from 'node:test';
import { materialAudioGaps, materialAudioTailWarning, materialGapFrameTimes, planMaterialAudioRepairs, sliceMaterialAudio } from '../lib/material-audio-coverage';
import { encodeRecordingWav, validateRecordingWav } from '../lib/recording-audio';

test('long audible untranscribed tail is flagged with source offset, without claiming it is speech',()=>{
  const pcm=new Int16Array(20*16000).fill(8000);
  const result={durationSeconds:20,segments:[{startSeconds:0,endSeconds:4.4,text:'已识别内容'}]};
  const warning=materialAudioTailWarning(encodeRecordingWav(pcm),result,60);
  assert.match(warning!,/64.4–80.0s/);assert.match(warning!,/背景音乐或漏识别/);
  assert.match(materialAudioTailWarning(encodeRecordingWav(pcm),{durationSeconds:20,segments:[]},0)!,/0.0–20.0s/);
});

test('silent tail, brief gap, isolated click and coarse timestamps do not imply missing speech',()=>{
  const result={durationSeconds:20,segments:[{startSeconds:0,endSeconds:4,text:'已识别内容'}]};
  const pcm=new Int16Array(20*16000);pcm.fill(8000,0,4*16000);
  assert.equal(materialAudioTailWarning(encodeRecordingWav(pcm),result,0),undefined);
  pcm[15*16000]=32767;
  assert.equal(materialAudioTailWarning(encodeRecordingWav(pcm),result,0),undefined);
  pcm.fill(8000);
  assert.equal(materialAudioTailWarning(encodeRecordingWav(pcm),{...result,segments:[{startSeconds:0,endSeconds:18,text:'内容'}]},0),undefined);
  assert.equal(materialAudioTailWarning(encodeRecordingWav(pcm),{...result,timingWarning:'整段定位'},0),undefined);
});

test('audible head, middle and tail gaps are detected around sorted merged transcript coverage',()=>{
  const pcm=new Int16Array(40*16_000);
  for(const [start,end] of [[0,6],[12,18],[30,40]])pcm.fill(8_000,start*16_000,end*16_000);
  const audio=encodeRecordingWav(pcm);
  const result={durationSeconds:40,segments:[
    {startSeconds:18,endSeconds:30,text:'后段'},
    {startSeconds:6,endSeconds:10,text:'前段'},
    {startSeconds:9,endSeconds:12,text:'重叠段'},
  ]};
  assert.deepEqual(materialAudioGaps(audio,result),[
    {startSeconds:0,endSeconds:6},
    {startSeconds:12,endSeconds:18},
    {startSeconds:30,endSeconds:40},
  ]);
  assert.deepEqual(materialAudioGaps(audio,{...result,timingWarning:'只能整段定位'}),[]);
});

test('gaps shorter than five seconds or with less than one audible second are ignored',()=>{
  const pcm=new Int16Array(20*16_000);
  pcm.fill(8_000,0,Math.floor(.74*16_000));
  pcm.fill(8_000,10*16_000,14*16_000);
  const audio=encodeRecordingWav(pcm);
  const result={durationSeconds:20,segments:[{startSeconds:5,endSeconds:10,text:'一'},{startSeconds:14,endSeconds:20,text:'二'}]};
  assert.deepEqual(materialAudioGaps(audio,result),[]);
});

test('audio slicing preserves exact PCM samples and rejects unsafe ranges',()=>{
  const pcm=Int16Array.from({length:10*16_000},(_,index)=>(index%30_000)-15_000);
  const audio=encodeRecordingWav(pcm),slice=sliceMaterialAudio(audio,1.25,3.75);
  assert.equal(validateRecordingWav(slice).durationSeconds,2.5);
  const view=new DataView(slice.buffer,slice.byteOffset,slice.byteLength);
  assert.equal(view.getInt16(44,true),pcm[1.25*16_000]);
  assert.equal(view.getInt16(slice.byteLength-2,true),pcm[3.75*16_000-1]);
  for(const range of [[-1,1],[2,2],[4,3],[0,11],[NaN,1],[0,Infinity]])assert.throws(()=>sliceMaterialAudio(audio,range[0],range[1]));
});

test('repair planning is bounded, continuous and distributed across gaps',()=>{
  const gaps=[{startSeconds:0,endSeconds:30},{startSeconds:40,endSeconds:48},{startSeconds:50,endSeconds:55}];
  assert.deepEqual(planMaterialAudioRepairs(gaps),[
    {startSeconds:0,endSeconds:12},
    {startSeconds:40,endSeconds:48},
    {startSeconds:50,endSeconds:55},
    {startSeconds:12,endSeconds:24},
  ]);
  assert.deepEqual(planMaterialAudioRepairs(gaps,0),[]);
  assert.throws(()=>planMaterialAudioRepairs(gaps,-1));
  assert.throws(()=>planMaterialAudioRepairs([{startSeconds:5,endSeconds:4}]));
});

test('audio slicing tolerates subtraction roundoff at the exact final sample but never extends audio',()=>{
  const audio=encodeRecordingWav(new Int16Array(309758).fill(1234));
  const end=79.359875-60;
  assert(end>validateRecordingWav(audio).durationSeconds);
  const tail=sliceMaterialAudio(audio,15,end);
  assert.equal(validateRecordingWav(tail).sampleCount,69758);
  assert.throws(()=>sliceMaterialAudio(audio,15,end+1/16000));
});

test('frame sampling uses three-second buckets and round-robins across gaps',()=>{
  const gaps=[{startSeconds:0,endSeconds:12},{startSeconds:30,endSeconds:36},{startSeconds:50,endSeconds:55}];
  assert.deepEqual(materialGapFrameTimes(gaps),[1.5,31.5,51.5,4.5,34.5,54]);
  assert.deepEqual(materialGapFrameTimes(gaps,0),[]);
  assert.throws(()=>materialGapFrameTimes(gaps,-1));
});
