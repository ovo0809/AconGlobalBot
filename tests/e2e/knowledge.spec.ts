import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('资料随报告保存，来源可展开且手机视口不溢出（本地合成资料）',async({page})=>{
  const publicRevision='d3282b368df25d4b952c813a7f000e5b5a3d1360';
  const injectedSource={
    id:'K_public_chat_visibility_regression',
    title:'长期护理宣传海报',
    path:'knowledge/提取文本/长期护理宣传海报.md',
    url:`https://github.com/ovo0809/AconGlobalBot/blob/${publicRevision}/knowledge/%E6%8F%90%E5%8F%96%E6%96%87%E6%9C%AC/%E9%95%BF%E6%9C%9F%E6%8A%A4%E7%90%86%E5%AE%A3%E4%BC%A0%E6%B5%B7%E6%8A%A5.md#L1-L28`,
    revision:publicRevision,startLine:1,endLine:28,
    excerpt:'公开固定来源回归：这段资料应继续保存在消息数据中，但不能出现在聊天框。',
    reviewStatus:'reference_only',
  };
  await page.route('**/api/bootstrap*',async route=>{
    const response=await route.fetch();
    const body=await response.json() as {mode?:string;activeCase?:{id?:string};clientSession?:{id?:string};messages?:Array<Record<string,unknown>>};
    if((body.mode==='client'||body.mode==='advisor')&&body.activeCase&&Array.isArray(body.messages)){
      const assistant=[...body.messages].reverse().find(message=>message.role==='assistant');
      if(assistant){
        assistant.text=`【注入公开来源回归】${String(assistant.text||'AI 回复')}`;
        assistant.knowledge={revision:publicRevision,status:'ready',notices:[],sources:[injectedSource]};
        assistant.knowledgeRefs=[injectedSource.id];
      }else{
        body.messages.push({id:'injected-public-source-message',caseId:body.activeCase.id||'case',sessionId:body.clientSession?.id||'history',turnId:'injected-public-source-turn',eventId:'injected-public-source-event',role:'assistant',text:'【注入公开来源回归】AI 回复',final:true,interrupted:false,createdAt:'2026-10-30T00:00:00.000Z',knowledge:{revision:publicRevision,status:'ready',notices:[],sources:[injectedSource]},knowledgeRefs:[injectedSource.id]});
      }
    }
    await route.fulfill({response,json:body});
  });
  await page.goto('/');
  await page.getByLabel('工作邮箱').fill('advisor1@aeconn.example');
  await page.getByLabel('密码').fill('AeconnDemo!2026');
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('button',{name:'退出'})).toBeVisible();
  const caseId=await page.evaluate(async()=>{
    const action=async(input:Record<string,unknown>)=>{
      const {csrf}=await fetch('/api/bootstrap').then(r=>r.json());
      const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(input)});
      const body=await response.json();if(!response.ok)throw new Error(body.error);return body;
    };
    const created=await action({action:'createClient',name:'知识资料引用合成客户',birthday:'1982-01-01',gender:'男性',phone:'+1 555 123 4567',email:'knowledge-ui@example.invalid',maritalStatus:'已婚',state:'CA',language:'中文'});
    await action({action:'enterClient',caseId:created.caseId});
    await action({action:'chooseEntry',entry:'life'});
    await action({action:'message',text:'希望保障家庭责任',eventId:'knowledge-ui-goal'});
    return created.caseId as string;
  });
  await page.reload();
  await expect(page.getByText(/【注入公开来源回归】/),'带公开来源的助手消息确实渲染在客户聊天中').toBeVisible();
  await expect(page.locator('.chat-stream .knowledge-sources'),'客户聊天不展示内部参考资料来源').toHaveCount(0);
  await page.evaluate(async()=>{
    const {csrf}=await fetch('/api/bootstrap').then(r=>r.json());
    const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action:'end'})});
    if(!response.ok)throw new Error((await response.json()).error);
  });
  await page.reload();
  await expect(page.getByText(/【注入公开来源回归】/),'带公开来源的助手消息确实渲染在顾问访谈记录中').toBeVisible();
  await expect(page.locator('.conversation-view .knowledge-sources'),'顾问访谈记录不展示内部参考资料来源').toHaveCount(0);
  await page.getByRole('button',{name:/内部报告/}).click();
  await expect(page.locator('.report-view')).toBeVisible({timeout:30_000});
  await page.getByText('来源编号与版本信息',{exact:true}).click();
  const sources=page.locator('.knowledge-sources');
  await sources.locator('summary').click();
  await expect(sources).toContainText('家庭保障与收入中断');
  await expect(sources).toContainText('合成示例／未批准');
  await expect(sources).toContainText('未被模型标注为引用');
  await expect(sources.getByRole('link'),'local test fixtures must not fabricate a GitHub source link').toHaveCount(0);
  const saved=await page.request.get(`/api/report?caseId=${caseId}&version=1`);
  expect(saved.ok()).toBeTruthy();const report=await saved.json();
  expect(report.knowledge.sources.length).toBeGreaterThan(0);
  expect(report.fullText).toContain('未调用 AI');
  const pdf=await page.request.get(report.pdfUrl);expect(pdf.ok()).toBeTruthy();
  expect((await pdf.body()).subarray(0,4).toString()).toBe('%PDF');
  const directory=join(process.cwd(),'tmp','validation','knowledge');mkdirSync(directory,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    if(viewport.width<500){await page.locator('.case-item').filter({hasText:'知识资料引用合成客户'}).click();await page.getByRole('button',{name:/内部报告/}).click();}
    await sources.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    expect(await sources.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await page.screenshot({path:join(directory,`sources-${viewport.width}.png`)});
  }
});
