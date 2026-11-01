import assert from 'node:assert/strict';
import test from 'node:test';
import { materialTranscoderAvailable, materialTranscoderEnvironment, parseMaterialTranscoderEvent, planMaterialSegments, transcodeMaterialVideo } from '../lib/material-transcoder';

test('material transcoder availability is restricted to Windows',()=>{
  assert.equal(materialTranscoderAvailable('win32'),true);assert.equal(materialTranscoderAvailable('linux'),false);assert.equal(materialTranscoderAvailable('darwin'),false);
});

test('transcoder child environment excludes provider credentials and unrelated application state',()=>{
  assert.deepEqual(materialTranscoderEnvironment({SystemRoot:'C:\\Windows',PATH:'safe-path',TEMP:'safe-temp',OPENAI_API_KEY:'secret',GEMINI_API_KEY:'secret',COOKIE:'secret',UNRELATED:'value'}),{SystemRoot:'C:\\Windows',PATH:'safe-path',TEMP:'safe-temp'});
});

test('large videos are planned into deterministic contiguous three-minute segments',()=>{
  assert.deepEqual(planMaterialSegments(541),[
    {index:0,startSeconds:0,endSeconds:180,filename:'part-000.mp4'},
    {index:1,startSeconds:180,endSeconds:360,filename:'part-001.mp4'},
    {index:2,startSeconds:360,endSeconds:540,filename:'part-002.mp4'},
    {index:3,startSeconds:540,endSeconds:541,filename:'part-003.mp4'},
  ]);
  assert.deepEqual(planMaterialSegments(180),[{index:0,startSeconds:0,endSeconds:180,filename:'part-000.mp4'}]);assert.throws(()=>planMaterialSegments(0),/无效/);assert.throws(()=>planMaterialSegments(181,181),/无效/);
});

test('transcoder events accept typed metadata and reject paths or malformed data',()=>{
  assert.deepEqual(parseMaterialTranscoderEvent('{"type":"segment","index":0,"filename":"part-000.mp4","startSeconds":0,"endSeconds":180,"actualDurationSeconds":180,"bytes":1234}'),{type:'segment',index:0,filename:'part-000.mp4',startSeconds:0,endSeconds:180,actualDurationSeconds:180,bytes:1234});
  assert.deepEqual(parseMaterialTranscoderEvent('{"type":"error","code":"UNSUPPORTED_MEDIA:CodecNotFound"}'),{type:'error',code:'UNSUPPORTED_MEDIA:CodecNotFound'});
  assert.throws(()=>parseMaterialTranscoderEvent('{"type":"error","code":"failed at C:\\\\private\\\\video.mp4"}'),/无法识别/);assert.throws(()=>parseMaterialTranscoderEvent('{"type":"segment","index":0.5}'),/无效/);assert.throws(()=>parseMaterialTranscoderEvent('not-json'),/无法识别/);
});

test('transcoder rejects untrusted container extensions and pre-cancelled work before spawning',async()=>{
  if(process.platform!=='win32'){
    await assert.rejects(()=>transcodeMaterialVideo({sourcePath:'/safe/source.mp4',outputDirectory:'/safe/job',maxDurationSeconds:7200}),/仅支持 Windows/);
    return;
  }
  await assert.rejects(()=>transcodeMaterialVideo({sourcePath:'C:\\safe\\source.bin',outputDirectory:'C:\\safe\\job',maxDurationSeconds:7200}),/路径无效/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>transcodeMaterialVideo({sourcePath:'C:\\safe\\source.mp4',outputDirectory:'C:\\safe\\job',maxDurationSeconds:7200,signal:controller.signal}),error=>error instanceof DOMException&&error.name==='AbortError');
});
