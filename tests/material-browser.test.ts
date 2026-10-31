import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMaterialAudioChunk } from '../lib/material-browser';

test('audio chunk pads unavailable tail with silence instead of repeating the final sample',async()=>{
  const source={sampleRate:10,length:1,numberOfChannels:1,getChannelData:()=>new Float32Array([.5])};
  const blob=renderMaterialAudioChunk(source,0,.2),view=new DataView(await blob.arrayBuffer());
  assert.equal(view.getInt16(44,true),Math.trunc(.5*0x7fff));
  assert.equal(view.getInt16(46,true),Math.trunc(.5*0x7fff),'resampling may read the first source sample while its time range remains valid');
  assert.equal(view.getInt16(44+(16_000*.15|0)*2,true),0,'samples after source end are silence');
  assert.equal(view.getInt16(view.byteLength-2,true),0,'the missing tail never repeats the final source sample');
});
