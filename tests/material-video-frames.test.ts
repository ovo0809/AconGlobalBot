import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { extractMaterialVideoFrames } from '../lib/material-video-frames';
import { materialTranscoderEnvironment } from '../lib/material-transcoder';

test('video frame helper rejects unsupported media, unsafe sizes and invalid time lists before native work',async()=>{
  await assert.rejects(()=>extractMaterialVideoFrames({video:new Uint8Array([1]),mimeType:'application/octet-stream',times:[0]}),/格式不受支持|仅支持 Windows/);
  if(process.platform!=='win32')return;
  await assert.rejects(()=>extractMaterialVideoFrames({video:new Uint8Array(),mimeType:'video/mp4',times:[0]}),/为空/);
  const video=new Uint8Array([1]);
  for(const times of [[],[0,1,2,3,4,5,6],[-1],[601],[NaN],[1,1]])await assert.rejects(()=>extractMaterialVideoFrames({video,mimeType:'video/mp4',times}),/时间无效/);
});

test('video frame child environment excludes provider credentials',()=>{
  assert.deepEqual(materialTranscoderEnvironment({SYSTEMROOT:'C:\\Windows',PATH:'safe',TEMP:'safe',OPENAI_API_KEY:'secret',DATABASE_PATH:'private'}),{SYSTEMROOT:'C:\\Windows',PATH:'safe',TEMP:'safe'});
});

test('Windows extracts bounded JPEG frames from a real synthetic MP4',{skip:process.platform!=='win32'},async()=>{
  const video=new Uint8Array(await readFile(join(process.cwd(),'tests','fixtures','materials','synthetic-h264-aac.mp4')));
  const frames=await extractMaterialVideoFrames({video,mimeType:'video/mp4',times:[0]});
  assert.deepEqual(frames.map(frame=>({timeSeconds:frame.timeSeconds,mimeType:frame.mimeType})),[{timeSeconds:0,mimeType:'image/jpeg'}]);
  for(const frame of frames){assert(frame.image.byteLength>100);assert.equal(frame.image[0],0xff);assert.equal(frame.image[1],0xd8);assert.equal(frame.image.at(-2),0xff);assert.equal(frame.image.at(-1),0xd9);}
});

test('Windows reports its native WebM decoder boundary without returning a fake frame',{skip:process.platform!=='win32'},async()=>{
  const video=new Uint8Array(await readFile(join(process.cwd(),'tests','fixtures','materials','synthetic-audio-video.webm')));
  try {
    const [frame]=await extractMaterialVideoFrames({video,mimeType:'video/webm',times:[0]});
    assert.equal(frame.mimeType,'image/jpeg');assert.equal(frame.image[0],0xff);assert.equal(frame.image[1],0xd8);
  } catch(error) {assert.match(String(error),/Windows 无法读取这个视频编码/);}
});
