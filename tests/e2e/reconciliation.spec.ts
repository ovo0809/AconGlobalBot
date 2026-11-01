import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const createdAt='2026-10-29T23:46:35.275Z';
type Pending={id:string;operation:string;model:string;createdAt:string;closedAt:string|null;status:'unknown'|'reserved';recordedMicros:number;reservedMicros:number;heldMicros:number;version:string;automaticReady:boolean};

const pendingCall=(overrides:Partial<Pending>={}):Pending=>({id:'ee52d28c-1dcd-4930-b8f1-2c94ef83b3fa',operation:'realtime',model:'gpt-realtime-2.1',createdAt,closedAt:'2026-10-29T23:46:59.430Z',status:'unknown',recordedMicros:0,reservedMicros:1_000_000,heldMicros:1_000_000,version:'version-1',automaticReady:false,...overrides});

function adminBootstrap(pending:Pending[]=[pendingCall()]){
  return {csrf:'admin-csrf',mode:'advisor',user:{id:'admin',name:'系统管理员',email:'admin@aeconn.example',role:'admin',orgId:'org-demo',emailVerified:true},clients:[],cases:[],activeCase:null,messages:[],facts:[],reports:[],notifications:[],reviews:[],settings:{companyEmail:'company@aeconn.example',companyVerified:false,unreviewedSendPolicy:'pending',mailMode:'dry_run'},users:[],capabilities:{analysis:'mock',voice:'未配置',voiceConfigured:false,mail:'dry-run'},demo:true,reconciliation:{limits:{caseMicros:8_000_000,dailyMicros:40_000_000,monthlyMicros:160_000_000},pending,history:[]}};
}

function advisorBootstrap(){return {csrf:'advisor-csrf',mode:'advisor',user:{id:'advisor-1',name:'林顾问',email:'advisor1@aeconn.example',role:'advisor',orgId:'org-demo',emailVerified:false},clients:[],cases:[],activeCase:null,messages:[],facts:[],reports:[],notifications:[],reviews:[],capabilities:{analysis:'mock',voice:'未配置',voiceConfigured:false,mail:'dry-run'},demo:true};}

async function stub(page:Page,options:{stalePreview?:boolean;rejectPreview?:string;versionAfterPreview?:boolean;failFirstSettle?:boolean}={}){
  let state=adminBootstrap();let settleCount=0,previewCount=0;const settlementRequestIds:string[]=[],settlementPreviewTokens:string[]=[];
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(state)}));
  await page.route('**/api/action',async(route:Route)=>{
    const body=route.request().postDataJSON() as Record<string,unknown>;
    if(body.action==='previewUsageSettlement'){
      previewCount++;
      if(options.stalePreview){state=adminBootstrap([pendingCall({version:'version-2'})]);return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'调用记录已变化。'})});}
      if(options.rejectPreview)return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:options.rejectPreview})});
      const confirmedMicros=Math.round(Number(body.amountUsd)*1_000_000);
      if(options.versionAfterPreview)state=adminBootstrap([pendingCall({version:'version-2'})]);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,preview:{previewToken:'signed-preview-token',callId:body.callId,version:body.version,recordedMicros:0,confirmedMicros,accountedMicros:confirmedMicros,releasedMicros:1_000_000-confirmedMicros,evidenceRef:body.evidenceRef,note:body.note}})});
    }
    if(body.action==='settleUsage'){
      settleCount++;settlementRequestIds.push(String(body.requestId));settlementPreviewTokens.push(String(body.previewToken));
      if(options.failFirstSettle&&settleCount===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'临时网络错误，请重试。'})});
      state=adminBootstrap([]);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:{releasedMicros:1_000_000}})});
    }
    if(body.action==='reconcileUsage')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:{settled:0}})});
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
  });
  return {settleCount:()=>settleCount,previewCount:()=>previewCount,settlementRequestIds:()=>settlementRequestIds,settlementPreviewTokens:()=>settlementPreviewTokens};
}

async function fillSettlement(page:Page,amount='0'){
  await page.getByRole('button',{name:'人工结算'}).click();
  await page.getByLabel('官方确认的本次最终金额（USD）').fill(amount);
  await page.getByLabel('官方证据编号或文件引用').fill('usage-export-2026-10.csv 第 8 行');
  await page.getByLabel('核对说明').fill(amount==='0'?'官方明细确认供应商在生成回复前拒绝，最终金额为零。':'官方费用导出与调用时间及模型一致。');
}

test('管理员预览、明确确认零费用并只提交一次结算',async({page})=>{
  const calls=await stub(page);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'调用对账与结算'})).toBeVisible();
  await expect(page.getByLabel('应用费用上限')).toContainText('每案例 $8');
  await expect(page.getByLabel('应用费用上限')).toContainText('每天 $40');
  await expect(page.getByLabel('应用费用上限')).toContainText('每月 $160');
  await fillSettlement(page);
  await page.getByRole('button',{name:'预览结算结果'}).click();
  const preview=page.getByLabel('结算预览');
  await expect(preview).toContainText('释放预留');
  await expect(preview).toContainText('$1');
  const settle=page.getByRole('button',{name:'确认结算并释放预留'});
  await expect(settle).toBeDisabled();
  await page.getByLabel(/我已核对官方证据/).check();
  await Promise.all([settle.click(),settle.click().catch(()=>undefined)]);
  await expect(page.getByText('结算已保存，确认未使用的预留已经释放。')).toBeVisible();
  expect(calls.previewCount()).toBe(1);expect(calls.settleCount()).toBe(1);
  expect(calls.settlementPreviewTokens()).toEqual(['signed-preview-token']);
});

test('服务器拒绝金额时不显示成功，也不能绕过预览',async({page})=>{
  const calls=await stub(page,{rejectPreview:'确认金额不能低于已记录费用。'});
  await page.goto('/');await fillSettlement(page,'0.01');
  await page.getByRole('button',{name:'预览结算结果'}).click();
  await expect(page.getByRole('status')).toContainText('确认金额不能低于已记录费用。');
  await expect(page.getByRole('button',{name:'确认结算并释放预留'})).toHaveCount(0);
  expect(calls.settleCount()).toBe(0);
});

test('记录版本变化会使预览失效并刷新',async({page})=>{
  const calls=await stub(page,{stalePreview:true});
  await page.goto('/');await fillSettlement(page,'0');
  await page.getByRole('button',{name:'预览结算结果'}).click();
  await expect(page.getByRole('status')).toContainText('记录已变化，预览已失效');
  await expect(page.getByRole('button',{name:'确认结算并释放预留'})).toHaveCount(0);
  expect(calls.settleCount()).toBe(0);
});

test('预览后后台版本变化会在提交前作废确认',async({page})=>{
  const calls=await stub(page,{versionAfterPreview:true});
  await page.goto('/');await fillSettlement(page,'0');
  await page.getByRole('button',{name:'预览结算结果'}).click();
  await expect(page.getByLabel('结算预览')).toBeVisible();
  await page.getByRole('button',{name:'立即自动核对'}).click();
  await expect(page.getByRole('status')).toContainText('原结算预览已经作废');
  await expect(page.getByLabel('结算预览')).toHaveCount(0);
  expect(calls.settleCount()).toBe(0);
});

test('结算传输失败后重试沿用同一个请求编号',async({page})=>{
  const calls=await stub(page,{failFirstSettle:true});
  await page.goto('/');await fillSettlement(page,'0');
  await page.getByRole('button',{name:'预览结算结果'}).click();await page.getByLabel(/我已核对官方证据/).check();
  await page.getByRole('button',{name:'确认结算并释放预留'}).click();
  await expect(page.getByRole('status')).toContainText('临时网络错误');
  await page.getByRole('button',{name:'确认结算并释放预留'}).click();
  await expect(page.getByRole('status')).toContainText('结算已保存');
  expect(calls.settlementRequestIds()).toHaveLength(2);
  expect(calls.settlementRequestIds()[0]).toBe(calls.settlementRequestIds()[1]);
});

test('390px 管理员对账可读且没有横向溢出',async({page})=>{
  await stub(page);await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.getByRole('heading',{name:'调用对账与结算'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  const target=join(process.cwd(),'tmp','validation','reconciliation-mobile.png');mkdirSync(join(process.cwd(),'tmp','validation'),{recursive:true});
  await page.screenshot({path:target,fullPage:true});
});

test('顾问页面不展示管理对账资料',async({page})=>{
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(advisorBootstrap())}));
  await page.goto('/');
  await expect(page.getByText('暂无客户案例')).toBeVisible();
  await expect(page.getByRole('heading',{name:'调用对账与结算'})).toHaveCount(0);
  await expect(page.getByText('每案例 $8')).toHaveCount(0);
});
