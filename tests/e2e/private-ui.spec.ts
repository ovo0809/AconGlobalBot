import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const screenshotDirectory=join(process.cwd(),'docs','screenshots','ui-refresh');
const centeredClientScreenshots=join(process.cwd(),'docs','screenshots','client-centered');
const createdAt='2026-10-30T16:00:00.000Z';
const updatedAt='2026-10-30T18:30:00.000Z';

const advisor={id:'advisor-ui',name:'林顾问',email:'advisor-ui@example.invalid',role:'advisor' as const,orgId:'org-ui',emailVerified:true};
const clients=[
  {id:'client-lin',name:'林悦（合成）',birthday:'1984-08-16',gender:'女性',phone:'+1 555 010 1001',email:'lin-yue@example.invalid',maritalStatus:'已婚',state:'CA',language:'中文',ownerAgentId:advisor.id,consentStatus:'synthetic',createdAt},
  {id:'client-chen',name:'陈宁（合成）',birthday:'1976-04-20',gender:'男性',phone:'+1 555 010 1002',email:'chen-ning@example.invalid',maritalStatus:'已婚',state:'WA',language:'中文',ownerAgentId:advisor.id,consentStatus:'synthetic',createdAt},
  {id:'client-zhao',name:'赵安（合成）',birthday:'1990-11-02',gender:'非二元／其他',phone:'+1 555 010 1003',email:'zhao-an@example.invalid',maritalStatus:'单身',state:'NY',language:'中文',ownerAgentId:advisor.id,consentStatus:'synthetic',createdAt},
];
const cases=[
  {id:'case-lin-01',clientId:'client-lin',ownerAgentId:advisor.id,status:'draft',entry:'ltc' as const,createdAt,updatedAt,assignedReviewerId:null,reportVersion:1,clientName:'林悦（合成）',caseNumber:1},
  {id:'case-chen-02',clientId:'client-chen',ownerAgentId:advisor.id,status:'pending_review',entry:'annuity' as const,createdAt,updatedAt:'2026-10-30T17:30:00.000Z',assignedReviewerId:'reviewer-ui',reportVersion:1,clientName:'陈宁（合成）',caseNumber:2},
  {id:'case-zhao-03',clientId:'client-zhao',ownerAgentId:advisor.id,status:'needs_report',entry:'life' as const,createdAt,updatedAt:'2026-10-30T16:30:00.000Z',assignedReviewerId:null,reportVersion:0,clientName:'赵安（合成）',caseNumber:3},
];
const messages=[
  {id:'message-1',caseId:'case-lin-01',sessionId:'session-lin',turnId:'turn-1',eventId:'event-1',role:'assistant' as const,text:'您希望这次规划先解决什么问题？',final:true,interrupted:false,createdAt:'2026-10-30T16:05:00.000Z',source:'synthetic' as const},
  {id:'message-2',caseId:'case-lin-01',sessionId:'session-lin',turnId:'turn-1',eventId:'event-2',role:'user' as const,text:'我想为退休后的长期照护提前做好安排。',final:true,interrupted:false,createdAt:'2026-10-30T16:06:00.000Z',source:'synthetic' as const},
  {id:'message-3',caseId:'case-lin-01',sessionId:'session-lin',turnId:'turn-2',eventId:'event-3',role:'assistant' as const,text:'如果未来需要照护，您更倾向在家里还是专业机构？',final:true,interrupted:false,createdAt:'2026-10-30T16:07:00.000Z',source:'synthetic' as const},
  {id:'message-4',caseId:'case-lin-01',sessionId:'session-lin',turnId:'turn-2',eventId:'event-4',role:'user' as const,text:'希望优先在家里，也想减少家人的压力。',final:true,interrupted:false,createdAt:'2026-10-30T16:08:00.000Z',source:'synthetic' as const},
];

function capabilities(){return {analysis:'mock（演示规则）',interview:'本地演示逻辑',voice:'mock（未调用实时语音服务）',voiceConfigured:false,mail:'dry-run（未发送）'};}

function advisorBootstrap(activeCaseId='case-lin-01'){
  const activeCase=cases.find(record=>record.id===activeCaseId)??cases[0];
  return {
    csrf:'ui-csrf',mode:'advisor' as const,user:advisor,clients,cases,deletedCases:[],activeCase,
    messages:activeCase.id==='case-lin-01'?messages:[],facts:[],reports:[],notifications:[],reviews:[],
    settings:{companyEmail:'company@example.invalid',companyVerified:true,unreviewedSendPolicy:'pending' as const,mailMode:'dry_run'},
    capabilities:capabilities(),demo:true,publicAccess:false,sharedDemo:false,
  };
}

function clientBootstrap(entry:null|'ltc'){
  return {
    csrf:'client-ui-csrf',mode:'client' as const,user:null,clients:[],cases:[],
    activeCase:{id:'case-client-ui',clientId:'',ownerAgentId:'',status:'interviewing',entry,createdAt,updatedAt,assignedReviewerId:null,reportVersion:0},
    messages:entry?messages.map(message=>({...message,caseId:'case-client-ui',sessionId:'session-client-ui'})):[],
    facts:[],reports:[],notifications:[],reviews:[],clientSession:{id:'session-client-ui',state:'active',entry},
    capabilities:capabilities(),demo:true,publicAccess:false,sharedDemo:false,
  };
}

async function stubAdvisor(page:Page){
  await page.route('**/api/bootstrap*',route=>{
    const requested=new URL(route.request().url()).searchParams.get('caseId')??'case-lin-01';
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(advisorBootstrap(requested))});
  });
  await page.route('**/api/action',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})}));
}

async function stubClient(page:Page,entry:null|'ltc'){
  const payload=clientBootstrap(entry);
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)}));
  await page.route('**/api/action',route=>{
    const action=route.request().postDataJSON() as {action?:string;entry?:'ltc'};
    if(action.action==='chooseEntry'){
      payload.clientSession.entry=action.entry??'ltc';payload.activeCase.entry=action.entry??'ltc';
    }
    if(action.action==='pause')payload.clientSession.state='paused';
    if(action.action==='resume')payload.clientSession.state='active';
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
  });
}

async function expectNoPageOverflow(page:Page){
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
}

async function hideDevelopmentChrome(page:Page){
  await page.evaluate(()=>document.querySelectorAll('nextjs-portal').forEach(element=>element.remove()));
}

async function expectInsideViewport(page:Page,selector:string){
  const box=await page.locator(selector).boundingBox();
  expect(box,`${selector} should be visible`).not.toBeNull();
  const viewport=page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width+.5);
  expect(box!.y+box!.height).toBeLessThanOrEqual(viewport.height+.5);
}

async function expectMobileBottomRail(page:Page){
  const rail=await page.locator('.rail').boundingBox();
  expect(rail,'mobile navigation should be rendered').not.toBeNull();
  const viewport=page.viewportSize()!;
  expect(rail!.x).toBeLessThanOrEqual(1);
  expect(rail!.width).toBeGreaterThanOrEqual(viewport.width-1);
  expect(Math.abs(rail!.y+rail!.height-viewport.height)).toBeLessThanOrEqual(1);
  expect(rail!.y).toBeGreaterThan(viewport.height/2);
}

async function expectMobileSurfaceFillsWidth(page:Page,selector:string){
  const surface=await page.locator(selector).boundingBox();
  expect(surface,`${selector} should be rendered`).not.toBeNull();
  const viewport=page.viewportSize()!;
  expect(surface!.x).toBeLessThanOrEqual(1);
  expect(surface!.width).toBeGreaterThanOrEqual(viewport.width-1);
  expect(surface!.x+surface!.width).toBeLessThanOrEqual(viewport.width+1);
}

async function expectHorizontallyCentered(page:Page,selector:string,tolerance=2){
  const surface=await page.locator(selector).boundingBox();
  expect(surface,`${selector} should be rendered`).not.toBeNull();
  const viewport=page.viewportSize()!;
  const surfaceMidpoint=surface!.x+surface!.width/2;
  expect(Math.abs(surfaceMidpoint-viewport.width/2)).toBeLessThanOrEqual(tolerance);
}

test.beforeAll(()=>{mkdirSync(screenshotDirectory,{recursive:true});mkdirSync(centeredClientScreenshots,{recursive:true});});

test('advisor workspace keeps the dossier usable without horizontal page overflow',async({page})=>{
  await stubAdvisor(page);
  for(const viewport of [{width:1440,height:1000},{width:1024,height:900},{width:768,height:900}]){
    await page.setViewportSize(viewport);await page.goto('/');
    await expect(page.getByText('专属规划档案 · CASE 01',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'开始客户访谈'})).toBeVisible();
    await expectNoPageOverflow(page);
    await expectInsideViewport(page,'.workspace');
    if(viewport.width===1440){await hideDevelopmentChrome(page);await page.screenshot({path:join(screenshotDirectory,'advisor-desktop-1440x1000.png'),fullPage:true});}
  }
});

test('mobile advisor can move between the case directory and selected dossier',async({page})=>{
  await stubAdvisor(page);await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('.case-sidebar')).toBeVisible();
  await expect(page.locator('.workspace')).toBeHidden();
  await expectMobileSurfaceFillsWidth(page,'.case-sidebar');
  await expectMobileBottomRail(page);
  await expectNoPageOverflow(page);
  await hideDevelopmentChrome(page);
  await page.screenshot({path:join(screenshotDirectory,'advisor-mobile-directory-390x844.png')});
  await page.locator('.case-item').filter({hasText:'林悦（合成）'}).click();
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.getByRole('button',{name:'返回案例列表'})).toBeVisible();
  await expect(page.getByRole('button',{name:'开始客户访谈'})).toBeVisible();
  await expectMobileSurfaceFillsWidth(page,'.workspace');
  await expectMobileBottomRail(page);
  await expect(page.getByRole('button',{name:'开始客户访谈'})).toBeInViewport();
  await expectNoPageOverflow(page);
  await hideDevelopmentChrome(page);
  await page.screenshot({path:join(screenshotDirectory,'advisor-mobile-dossier-390x844.png')});
  await page.getByRole('button',{name:'返回案例列表'}).click();
  await expect(page.locator('.case-sidebar')).toBeVisible();
});

test('keyboard users can identify focus, open new-client setup and dismiss it with Escape',async({page})=>{
  await stubAdvisor(page);await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  const newClient=page.getByRole('button',{name:'新建客户'});
  for(let step=0;step<12&&!(await newClient.evaluate(element=>element===document.activeElement));step+=1)await page.keyboard.press('Tab');
  await expect(newClient).toBeFocused();
  expect(await newClient.evaluate(element=>element.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog',{name:'建立客户档案'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'建立客户档案'})).toHaveCount(0);
});

test('client welcome uses one centered interview window at desktop and mobile widths',async({page})=>{
  await stubClient(page,null);
  for(const viewport of [{width:1440,height:1000},{width:886,height:865},{width:768,height:900},{width:390,height:844},{width:360,height:640}]){
    await page.setViewportSize(viewport);await page.goto('/');
    await expect(page.getByRole('heading',{name:/从您最在意的事，\s*慢慢聊起。/})).toBeVisible();
    await expect(page.getByRole('region',{name:'客户访谈'})).toBeVisible();
    await expect(page.locator('.client-backdrop')).toHaveCount(0);
    for(const label of ['人寿','伤残保险','年金','长期护理'])await expect(page.getByRole('button',{name:new RegExp(label)})).toBeVisible();
    await expectHorizontallyCentered(page,'.assistant-panel');
    const panel=await page.locator('.assistant-panel').boundingBox();
    const expectedWidth=Math.min(880,viewport.width-(viewport.width>=768?64:24));
    expect(panel!.width).toBeGreaterThanOrEqual(expectedWidth);
    await expectNoPageOverflow(page);
    await hideDevelopmentChrome(page);
    const screenshot=viewport.width===1440?'welcome-1440x1000.png':viewport.width===886?'welcome-886x865.png':viewport.width===390?'welcome-mobile-390x844.png':null;
    if(screenshot)await page.screenshot({path:join(centeredClientScreenshots,screenshot)});
  }
});

test('active interview stays centered with conversation and controls in one window',async({page})=>{
  await stubClient(page,'ltc');
  for(const viewport of [{width:1440,height:1000},{width:886,height:865},{width:768,height:900},{width:390,height:844},{width:360,height:640}]){
    await page.setViewportSize(viewport);await page.goto('/');
    await expect(page.locator('.client-backdrop')).toHaveCount(0);
    await expectHorizontallyCentered(page,'.assistant-panel');
    await expect(page.getByText('我想为退休后的长期照护提前做好安排。',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'开始连续语音对话'})).toBeVisible();
    await expect(page.getByRole('button',{name:'暂停访谈'})).toBeVisible();
    await expect(page.getByRole('button',{name:'结束对话'})).toBeVisible();
    await expectInsideViewport(page,'.assistant-controls');
    await expectNoPageOverflow(page);
    await hideDevelopmentChrome(page);
    if(viewport.width===1440)await page.screenshot({path:join(centeredClientScreenshots,'active-1440x1000.png')});
    if(viewport.width===390)await page.screenshot({path:join(centeredClientScreenshots,'active-mobile-390x844.png')});
  }
});

test('short mobile interview scrolls the conversation while keeping controls reachable',async({page})=>{
  await stubClient(page,'ltc');await page.setViewportSize({width:390,height:667});await page.goto('/');
  await expect(page.getByRole('button',{name:'开始连续语音对话'})).toBeVisible();
  await expect(page.getByRole('button',{name:'开始连续语音对话'})).toBeInViewport();
  await expect(page.getByRole('button',{name:'暂停访谈'})).toBeInViewport();
  await expect(page.getByRole('button',{name:'结束对话'})).toBeInViewport();
  await expectInsideViewport(page,'.assistant-controls');
  expect(await page.locator('.assistant-content').evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
  await expectNoPageOverflow(page);
});


test('client topic selection and pause controls work with a narrow keyboard layout',async({page})=>{
  await stubClient(page,null);await page.setViewportSize({width:360,height:640});await page.goto('/');
  const topic=page.getByRole('button',{name:'长期护理 照护偏好与家庭支持'});
  for(let step=0;step<8&&!(await topic.evaluate(element=>element===document.activeElement));step+=1)await page.keyboard.press('Tab');
  await expect(topic).toBeFocused();
  expect(await topic.evaluate(element=>element.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'开始连续语音对话'})).toBeInViewport();
  const identity=await page.locator('.assistant-identity').boundingBox();
  const actions=await page.locator('.interview-header-actions').boundingBox();
  expect(identity!.x+identity!.width).toBeLessThanOrEqual(actions!.x);
  await page.getByRole('button',{name:'暂停访谈'}).click();
  await expect(page.locator('.interview-status')).toHaveText('访谈已暂停');
  await expect(page.getByRole('button',{name:'恢复访谈'})).toBeInViewport();
  await expect(page.getByRole('button',{name:'结束对话'})).toBeInViewport();
  await expect(page.getByRole('button',{name:'开始连续语音对话'})).toHaveCount(0);
  await page.getByRole('button',{name:'恢复访谈'}).click();
  await expect(page.getByRole('button',{name:'开始连续语音对话'})).toBeInViewport();
  await expect(page.locator('.interview-status')).toHaveText('等待开始');
  await expectNoPageOverflow(page);
});
