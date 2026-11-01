import assert from 'node:assert/strict';
import test from 'node:test';
import { materialVideoAudioRanges, materialVideoFrameTimes, renderMaterialAudioChunk } from '../lib/material-browser';

test('short audio ranges retain all samples around 30/60s and keep the final partial segment',async()=>{
  const duration=79.36,ranges=materialVideoAudioRanges(duration);
  assert.deepEqual(ranges.map(range=>range.startSeconds),[0,15,30,45,60,75]);
  assert.equal(ranges.at(-1)!.endSeconds,duration);
  const samples=Float32Array.from({length:Math.round(duration*16000)},(_,index)=>(index%100)/100);
  const source={sampleRate:16000,length:samples.length,numberOfChannels:1,getChannelData:()=>samples};
  let total=0;
  for(const range of ranges){const buffer=await renderMaterialAudioChunk(source,range.startSeconds,range.endSeconds).arrayBuffer();total+=(buffer.byteLength-44)/2;const view=new DataView(buffer);assert.equal(view.getInt16(44,true),Math.trunc(samples[range.startSeconds*16000]*0x7fff));}
  assert.equal(total,samples.length);assert.equal(materialVideoAudioRanges(600).length,40);
  for(const value of [0,-1,601,NaN,Infinity])assert.throws(()=>materialVideoAudioRanges(value));
});

test('video frame samples include the ending and stay ordered within the existing 20-frame bound',()=>{
  assert.deepEqual(materialVideoFrameTimes(79.36),[0,30,60,79.31]);
  for(const duration of [.01,.5,1,30,60,570,600]){
    const starts=materialVideoFrameTimes(duration);
    assert(starts.length<=20);assert.equal(starts[0],0);
    assert(starts.every((value,i)=>value<duration&&(i===0||value>starts[i-1])));
    assert(duration-starts.at(-1)!<=1.05);
  }
  for(const duration of [0,-1,NaN,Infinity,601])assert.throws(()=>materialVideoFrameTimes(duration));
});

test('audio chunk pads unavailable tail with silence instead of repeating the final sample',async()=>{
  const source={sampleRate:10,length:1,numberOfChannels:1,getChannelData:()=>new Float32Array([.5])};
  const blob=renderMaterialAudioChunk(source,0,.2),view=new DataView(await blob.arrayBuffer());
  assert.equal(view.getInt16(44,true),Math.trunc(.5*0x7fff));
  assert.equal(view.getInt16(46,true),Math.trunc(.5*0x7fff),'resampling may read the first source sample while its time range remains valid');
  assert.equal(view.getInt16(44+(16_000*.15|0)*2,true),0,'samples after source end are silence');
  assert.equal(view.getInt16(view.byteLength-2,true),0,'the missing tail never repeats the final source sample');
});
