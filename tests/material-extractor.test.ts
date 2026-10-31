import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root=mkdtempSync(join(tmpdir(),'aeconn-material-extractor-'));
process.env.DATABASE_PATH=join(root,'test.sqlite');
process.env.DEMO_PASSWORD='AeconnDemo!2026';
process.env.MAIL_MODE='dry_run';
process.env.LLM_PROVIDER='openai';
process.env.OPENAI_API_KEY='synthetic-no-network';
process.env.OPENAI_MODEL='gpt-6-luna';
process.env.AI_CASE_BUDGET_USD='8';
process.env.AI_DAILY_BUDGET_USD='40';
process.env.AI_MONTHLY_BUDGET_USD='160';

const {extractMaterialImage}=await import('../lib/material-extractor');
const {db}=await import('../lib/db');

const image=new Uint8Array([0x89,0x50,0x4e,0x47]);
const context={caseId:'case-1',sessionId:'material-test'};
const usage={input_tokens:2800,output_tokens:300,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0},total_tokens:3100};

function calls(){return db().prepare("SELECT status,reserved_micros,actual_micros FROM ai_usage_calls WHERE session_id='material-test' ORDER BY rowid").all() as {status:string;reserved_micros:number;actual_micros:number}[];}
function response(overrides:Record<string,unknown>={}){
  return new Response(JSON.stringify({id:`resp_${crypto.randomUUID()}`,status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:'# 提取结果\n\n保费：待核对。'}]}],...overrides}),{headers:{'x-request-id':`req_${crypto.randomUUID()}`}});
}

test('mock extraction is conspicuously synthetic and does not create usage',async()=>{
  const before=calls().length;
  const result=await extractMaterialImage({image,mimeType:'image/png',context,provider:'mock'});
  assert.equal(result.provider,'mock');
  assert.match(result.text,/模拟图片提取/);
  assert.match(result.text,/不能视为图片文字/);
  assert.equal(calls().length,before);
});

test('OpenAI image extraction sends a bounded high-detail request and settles returned usage',async t=>{
  let requestBody:Record<string,unknown>|undefined;
  t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{requestBody=JSON.parse(String(options?.body));return response();});
  const before=calls().length;
  const result=await extractMaterialImage({image,mimeType:'image/png',context,provider:'openai'});
  assert.equal(result.provider,'openai');
  assert.match(result.text,/保费/);
  assert.equal(requestBody?.store,false);
  assert.equal(requestBody?.max_output_tokens,4096);
  const item=((requestBody?.input as {content:Record<string,unknown>[]}[])[0].content[1]);
  assert.equal(item.type,'input_image');assert.equal(item.detail,'high');assert.match(String(item.image_url),/^data:image\/png;base64,/);
  const row=calls().at(-1)!;
  assert.equal(calls().length,before+1);assert.equal(row.status,'settled');assert(row.actual_micros>0);assert(row.actual_micros<row.reserved_micros);
});

test('invalid completed output still settles provider usage before rejecting the extraction',async t=>{
  t.mock.method(globalThis,'fetch',async()=>response({output:[]}));
  await assert.rejects(()=>extractMaterialImage({image,mimeType:'image/png',context,provider:'openai'}),/文字为空或过长/);
  const row=calls().at(-1)!;assert.equal(row.status,'settled');assert(row.actual_micros>0);
});

test('incomplete final response settles known usage but does not return partial text',async t=>{
  t.mock.method(globalThis,'fetch',async()=>response({status:'incomplete'}));
  await assert.rejects(()=>extractMaterialImage({image,mimeType:'image/png',context,provider:'openai'}),/没有完整完成/);
  const row=calls().at(-1)!;assert.equal(row.status,'settled');assert(row.actual_micros>0);
});

test('transport ambiguity preserves the full reservation as unknown',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('synthetic network failure');});
  await assert.rejects(()=>extractMaterialImage({image,mimeType:'image/png',context,provider:'openai'}),/未完成/);
  const row=calls().at(-1)!;assert.equal(row.status,'unknown');assert.equal(row.actual_micros,0);assert.equal(row.reserved_micros,50_000);
});

test('malformed provider usage keeps the reservation unknown for reconciliation',async t=>{
  t.mock.method(globalThis,'fetch',async()=>response({usage:{input_tokens:'invalid'}}));
  await assert.rejects(()=>extractMaterialImage({image,mimeType:'image/png',context,provider:'openai'}),/未完成/);
  const row=calls().at(-1)!;assert.equal(row.status,'unknown');assert.equal(row.actual_micros,0);assert.equal(row.reserved_micros,50_000);
});

test('zero budget blocks before any provider request',async t=>{
  process.env.AI_CASE_BUDGET_USD='0';
  t.after(()=>{process.env.AI_CASE_BUDGET_USD='8';});
  const fetch=t.mock.method(globalThis,'fetch',async()=>response());
  await assert.rejects(()=>extractMaterialImage({image,mimeType:'image/png',context:{caseId:'case-2',sessionId:'material-test-zero'},provider:'openai'}),/费用上限/);
  assert.equal(fetch.mock.callCount(),0);
});
