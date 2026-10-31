import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect, type Page } from '@playwright/test';
import type { Bootstrap } from '../lib/domain';
import type { SharedDemoCredential } from './shared-demo-runtime';

const status=JSON.parse(readFileSync('output/shared-demo/current.json','utf8')) as {state:string;publicUrl:string;runRoot:string;credentialsPath:string};
assert.equal(status.state,'running');
assert.match(status.publicUrl,/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
const credentials=JSON.parse(readFileSync(status.credentialsPath,'utf8')) as SharedDemoCredential[];
const browser=await chromium.launch({headless:true});
let providerRequests=0;
const context=await browser.newContext({baseURL:status.publicUrl,viewport:{width:1440,height:900}});
context.on('request',request=>{if(/api\.openai\.com|generativelanguage\.googleapis\.com/.test(request.url()))providerRequests++;});
const page=await context.newPage();
page.setDefaultTimeout(30_000);
async function state(target:Page=page):Promise<Bootstrap>{return target.evaluate(async()=>fetch('/api/bootstrap',{cache:'no-store'}).then(r=>r.json()));}
async function action(target:Page,body:Record<string,unknown>,headers:Record<string,string>={}){
  return target.evaluate(async({body,headers})=>{
    const data=await fetch('/api/bootstrap',{cache:'no-store'}).then(r=>r.json());
    const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':data.csrf,...headers},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  },{body,headers});
}
try{
  const response=await page.goto(status.publicUrl);
  assert.equal(response?.status(),200);
  assert.match(response?.headers()['x-robots-tag']||'',/noindex/);
  await expect(page.getByText('共享模拟测试版',{exact:true})).toBeVisible();
  await expect(page.getByLabel('工作邮箱')).toBeEmpty();
  await expect(page.getByLabel('密码')).toBeEmpty();
  await expect(page.getByText('查看本地演示账号')).toHaveCount(0);
  assert.equal((await action(page,{action:'login',email:credentials[0].email,password:'AeconnDemo!2026'})).status,401);
  await page.getByLabel('工作邮箱').fill(credentials[0].email);
  await page.getByLabel('密码').fill(credentials[0].password);
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await expect(page.locator('.shared-demo-notice')).toBeVisible();
  const initial=await state();assert.equal(initial.sharedDemo,true);assert.equal(initial.user?.role,'advisor');assert.equal(initial.capabilities.voiceConfigured,false);
  assert.equal((await action(page,{action:'reconcileUsage'})).status,403);
  assert.equal((await action(page,{action:'logout'},{'x-csrf-token':'wrong'})).status,403);
  await page.getByRole('button',{name:'新建客户',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'建立客户档案'});
  const name=`共享链路验证（合成）${Date.now()}`;
  await dialog.getByLabel('姓名 *').fill(name);
  await dialog.getByLabel('生日 *').fill('1986-06-18');
  await dialog.getByLabel('性别 *').selectOption({label:'女性'});
  await dialog.getByLabel('电话号码 *').fill('+1 202 555 0199');
  await dialog.getByLabel('邮箱 *').fill('shared-check@example.invalid');
  await dialog.getByLabel('婚姻状态 *').selectOption({label:'已婚'});
  await dialog.getByRole('button',{name:'建立档案与案例'}).click();
  await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
  const caseId=(await state()).activeCase!.id;
  const other=await browser.newContext({baseURL:status.publicUrl});
  const otherPage=await other.newPage();await otherPage.goto('/');
  await expect(otherPage.getByRole('button',{name:'登录工作台',exact:true})).toBeVisible();
  assert.equal((await action(otherPage,{action:'login',email:credentials[1].email,password:credentials[1].password})).status,200);
  assert.ok(!(await state(otherPage)).cases.some(c=>c.id===caseId));
  assert.equal((await otherPage.request.get(`/api/bootstrap?caseId=${caseId}`)).status(),403);
  await other.close();
  await page.screenshot({path:join(status.runRoot,'desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'开始客户访谈',exact:true}).click();
  await expect(page.getByText('受限客户模式')).toBeVisible();
  await page.getByRole('button',{name:/人寿/}).click();
  await expect(page.getByRole('button',{name:/开始连续语音对话/})).toHaveCount(0);
  await page.getByLabel('文字回答').fill('我希望为家人准备保障，计划明年开始。');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByText('哪些家人依赖您的收入？如果收入停止，家庭有哪些责任？')).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(status.runRoot,'client-mobile.png')});
  await page.getByRole('button',{name:'结束对话',exact:true}).click();
  await expect.poll(async()=>(await state()).reportJob?.status,{timeout:40_000}).toBe('ready');
  const report=(await state()).reports[0];assert.ok(report.provider.includes('mock'));
  const pdf=await page.request.get(report.pdfUrl);
  assert.equal(pdf.status(),200);assert.equal((await pdf.body()).subarray(0,5).toString(),'%PDF-');
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:/内部报告/}).click();
  await expect(page.getByText('演示规则，待业务审核')).toBeVisible();
  await page.screenshot({path:join(status.runRoot,'report.png'),fullPage:true});
  for(const command of ['deleteCase','restoreCase','deleteCase','purgeCase']){
    assert.equal((await action(page,{action:command,caseId,...(command==='purgeCase'?{confirmation:'永久删除'}:{})})).status,200);
  }
  assert.equal(providerRequests,0);
  const db=new DatabaseSync(join(status.runRoot,'data','shared-demo.sqlite'),{readOnly:true});
  const usageCount=Number(db.prepare('SELECT COUNT(*) n FROM ai_usage_calls').get()!.n);db.close();
  assert.equal(usageCount,0);
  const evidence={testedAt:new Date().toISOString(),url:status.publicUrl,mode:'mock',browser:'Playwright Chromium',checks:['HTTPS login','default password rejected','two-advisor isolation','admin action rejected','CSRF rejected','synthetic client creation','mock text interview','mobile viewport 390x844','background report','PDF download','trash restore/purge'],paidBrowserRequests:providerRequests,sharedUsageCalls:usageCount,realApiTested:false,physicalPhoneTested:false};
  writeFileSync(join(status.runRoot,'validation.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}catch(error){
  let message=error instanceof Error?error.message:String(error);
  for(const credential of credentials)message=message.replaceAll(credential.password,'[REDACTED]');
  console.error(message);process.exitCode=1;
}finally{await browser.close();}
