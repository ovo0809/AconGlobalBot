import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSharedDemoEnvironment, isSharedDemo } from '../lib/shared-demo-policy';

const safe={SHARE_DEMO_MODE:'mock',LLM_PROVIDER:'mock',VOICE_PROVIDER:'mock',RECORDING_PROVIDER:'mock',MAIL_MODE:'dry_run',HOST:'127.0.0.1',DATABASE_PATH:'./output/test/data/aeconn.sqlite',HTTPS_PROXY_ORIGIN:'https://example.trycloudflare.com',AI_CASE_BUDGET_USD:'8',AI_DAILY_BUDGET_USD:'40',AI_MONTHLY_BUDGET_USD:'160'};
test('shared demo rejects paid providers, credentials, non-loopback and unsafe origins',()=>{
  assert.doesNotThrow(()=>assertSharedDemoEnvironment(safe));
  for(const [name,value] of Object.entries({SHARE_DEMO_MODE:'openai',LLM_PROVIDER:'openai',VOICE_PROVIDER:'gemini',RECORDING_PROVIDER:'openai',OPENAI_API_KEY:'test-only-placeholder',GEMINI_API_KEY:'test-only-placeholder',MAIL_MODE:'live',HOST:'0.0.0.0',DATABASE_PATH:'',HTTPS_PROXY_ORIGIN:'http://localhost',AI_CASE_BUDGET_USD:'9',AI_DAILY_BUDGET_USD:'41',AI_MONTHLY_BUDGET_USD:'161'})){
    assert.throws(()=>assertSharedDemoEnvironment({...safe,[name]:value}),name);
  }
  for(const origin of ['https://example.com/path','https://example.com/','https://user:password@example.com'])assert.throws(()=>assertSharedDemoEnvironment({...safe,HTTPS_PROXY_ORIGIN:origin}));
});
test('local configuration remains independent of shared mode',()=>{
  assert.equal(isSharedDemo({}),false);
  assert.doesNotThrow(()=>assertSharedDemoEnvironment({LLM_PROVIDER:'openai',VOICE_PROVIDER:'openai'}));
});
