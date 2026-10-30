import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('资料随报告保存，来源可展开且手机视口不溢出（本地合成资料）',async({page})=>{
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
    await action({action:'end'});
    return created.caseId as string;
  });
  await page.reload();
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
